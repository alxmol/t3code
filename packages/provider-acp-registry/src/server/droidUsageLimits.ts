import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const decodeDroidSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      customModels: Schema.optional(
        Schema.Array(
          Schema.Struct({
            baseUrl: Schema.optional(Schema.String),
            apiKey: Schema.optional(Schema.String),
            provider: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

const UsageWindow = Schema.NullOr(
  Schema.Struct({
    utilization: Schema.NullOr(Schema.Number),
    resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

// factory-cc's `GET /v1/usage`: the plan limits Claude Code's own /usage shows.
const BridgeUsageResponse = Schema.Struct({
  rate_limits_available: Schema.Boolean,
  rate_limits: Schema.NullOr(
    Schema.Struct({
      five_hour: Schema.optional(UsageWindow),
      seven_day: Schema.optional(UsageWindow),
      model_scoped: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              display_name: Schema.String,
              utilization: Schema.NullOr(Schema.Number),
              resets_at: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
    }),
  ),
});

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (
      protocol === "http:" &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** Droid sends a custom model's key to its base URL; the bridge's client token is that key. */
export function droidSubscriptionBridge(
  settingsJson: string,
): { readonly baseUrl: string; readonly token: string } | undefined {
  const settings = decodeDroidSettings(settingsJson);
  if (Option.isNone(settings)) return undefined;
  for (const model of settings.value.customModels ?? []) {
    const baseUrl = model.baseUrl?.trim().replace(/\/+$/, "");
    const token = model.apiKey?.trim();
    if (model.provider === "anthropic" && baseUrl && token && isLoopbackUrl(baseUrl)) {
      return { baseUrl, token };
    }
  }
  return undefined;
}

export function droidBridgeUsageToLimits(
  response: typeof BridgeUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (!response.rate_limits_available || !response.rate_limits) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: response.rate_limits_available ? "probeFailed" : "unsupported",
    });
  }
  const limits = response.rate_limits;
  const windows: ServerProviderUsageWindow[] = [];
  const push = (
    window: Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">,
    reported: {
      readonly utilization: number | null;
      readonly resets_at?: string | null | undefined;
    },
  ) => {
    if (typeof reported.utilization !== "number") return;
    const resetsAt = isoFromString(reported.resets_at);
    windows.push({
      ...window,
      usedPercent: clampPercent(reported.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };
  if (limits.five_hour) {
    push(
      {
        id: "claude_five_hour",
        kind: "session",
        label: "Claude Session",
        windowDurationMins: SESSION_MINS,
      },
      limits.five_hour,
    );
  }
  if (limits.seven_day) {
    push(
      {
        id: "claude_seven_day",
        kind: "weekly",
        label: "Claude Weekly",
        windowDurationMins: WEEK_MINS,
      },
      limits.seven_day,
    );
  }
  for (const scoped of limits.model_scoped ?? []) {
    push(
      {
        id: `claude_seven_day_${scoped.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        kind: "weekly",
        label: `Claude Weekly · ${scoped.display_name}`,
        windowDurationMins: WEEK_MINS,
      },
      scoped,
    );
  }
  return makeUsageLimits({ checkedAt, windows });
}

/**
 * The Claude subscription limits behind Droid's local bridge models. Undefined when Droid has
 * no such bridge, or it answers without a usage report: Droid's own credits have no limit API.
 */
export const readDroidSubscriptionUsageLimits = Effect.fn("readDroidSubscriptionUsageLimits")(
  function* (environment: NodeJS.ProcessEnv) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = environment.HOME ?? environment.USERPROFILE;
    if (!home) return undefined;
    const settingsJson = yield* fileSystem
      .readFileString(path.join(home, ".factory", "settings.json"))
      .pipe(Effect.option);
    const bridge = Option.isSome(settingsJson)
      ? droidSubscriptionBridge(settingsJson.value)
      : undefined;
    if (bridge === undefined) return undefined;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.get(`${bridge.baseUrl}/v1/usage`).pipe(
          HttpClientRequest.bearerToken(bridge.token),
        ),
      )
      .pipe(
        Effect.flatMap((response): Effect.Effect<ServerProviderUsageLimits | undefined, unknown> =>
          response.status === 404 || response.status === 501
            ? Effect.undefined
            : HttpClientResponse.filterStatusOk(response).pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(BridgeUsageResponse)),
                Effect.map((body) => droidBridgeUsageToLimits(body, checkedAt)),
              ),
        ),
        Effect.timeout("25 seconds"),
        Effect.orElseSucceed(() =>
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Droid's Claude subscription bridge did not report usage limits.",
          }),
        ),
      );
  },
);
