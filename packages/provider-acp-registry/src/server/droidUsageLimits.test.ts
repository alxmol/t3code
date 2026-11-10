import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  droidBridgeUsageToLimits,
  droidSubscriptionBridge,
  readDroidSubscriptionUsageLimits,
} from "./droidUsageLimits.ts";

const checkedAt = "2026-11-10T00:00:00.000Z";

const settingsJson = JSON.stringify({
  customModels: [
    {
      model: "claude-opus-5-5",
      baseUrl: "https://api.anthropic.com",
      apiKey: "api-key",
      provider: "anthropic",
    },
    {
      model: "claude-opus-5-5",
      baseUrl: "http://127.0.0.1:18787/",
      apiKey: "bridge-token",
      provider: "anthropic",
    },
  ],
});

const usage = {
  checkedAt,
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: "2026-11-10T05:00:00+00:00" },
    seven_day: { utilization: 7, resets_at: "2026-11-11T12:00:00.479388+00:00" },
    seven_day_opus: null,
    model_scoped: [
      { display_name: "Fable", utilization: 6, resets_at: "2026-11-11T12:00:00+00:00" },
    ],
  },
};

const withHome = (settings: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-droid-usage-" });
    if (settings !== undefined) {
      yield* fileSystem.makeDirectory(path.join(home, ".factory"));
      yield* fileSystem.writeFileString(path.join(home, ".factory", "settings.json"), settings);
    }
    return { HOME: home };
  });

const respond = (status: number, body: unknown, seen: Array<{ url: string; auth?: string }> = []) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push({
        url: request.url,
        ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      );
    }),
  );

describe("Droid subscription usage limits", () => {
  it("finds the loopback Anthropic model among Droid's custom models", () => {
    expect(droidSubscriptionBridge(settingsJson)).toEqual({
      baseUrl: "http://127.0.0.1:18787",
      token: "bridge-token",
    });
    expect(
      droidSubscriptionBridge(
        JSON.stringify({
          customModels: [{ baseUrl: "http://127.0.0.1:1234", apiKey: "x", provider: "openai" }],
        }),
      ),
    ).toBeUndefined();
    expect(droidSubscriptionBridge("not json")).toBeUndefined();
  });

  it("names the Claude windows so they cannot pass for Droid's own allowance", () => {
    expect(droidBridgeUsageToLimits(usage, checkedAt).windows).toEqual([
      {
        id: "claude_five_hour",
        kind: "session",
        label: "Claude Session",
        windowDurationMins: 300,
        usedPercent: 12,
        resetsAt: "2026-11-10T05:00:00.000Z",
      },
      {
        id: "claude_seven_day",
        kind: "weekly",
        label: "Claude Weekly",
        windowDurationMins: 10_080,
        usedPercent: 7,
        resetsAt: "2026-11-11T12:00:00.479Z",
      },
      {
        id: "claude_seven_day_fable",
        kind: "weekly",
        label: "Claude Weekly · Fable",
        windowDurationMins: 10_080,
        usedPercent: 6,
        resetsAt: "2026-11-11T12:00:00.000Z",
      },
    ]);
    expect(
      droidBridgeUsageToLimits({ rate_limits_available: false, rate_limits: null }, checkedAt)
        .unavailable?.reason,
    ).toBe("unsupported");
  });

  it.effect("asks the bridge with the model's key", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth?: string }> = [];
      const limits = yield* readDroidSubscriptionUsageLimits(yield* withHome(settingsJson)).pipe(
        respond(200, usage, seen),
      );
      expect(limits?.windows.map((window) => window.id)).toEqual([
        "claude_five_hour",
        "claude_seven_day",
        "claude_seven_day_fable",
      ]);
      expect(seen).toEqual([
        { url: "http://127.0.0.1:18787/v1/usage", auth: "Bearer bridge-token" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports nothing without a bridge or from a server that has no usage route", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string }> = [];
      expect(
        yield* readDroidSubscriptionUsageLimits(yield* withHome(undefined)).pipe(
          respond(200, usage, seen),
        ),
      ).toBeUndefined();
      expect(seen).toEqual([]);
      expect(
        yield* readDroidSubscriptionUsageLimits(yield* withHome(settingsJson)).pipe(
          respond(404, { type: "error" }),
        ),
      ).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("marks the probe failed when the bridge cannot report usage", () =>
    Effect.gen(function* () {
      const limits = yield* readDroidSubscriptionUsageLimits(yield* withHome(settingsJson)).pipe(
        respond(503, { type: "error", error: { type: "usage_unavailable" } }),
      );
      expect(limits?.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
