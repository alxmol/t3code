import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as EffectAcpSchema from "effect-acp/compat";

const READ_TIMEOUT = "30 seconds";
const QUIET = "700 millis";
const MAX_QUIET_ROUNDS = 12;
const MINUTES: Record<string, number> = { w: 10_080, d: 1_440, h: 60, m: 1 };
const DEVIN_USAGE_URL = "https://app.devin.ai/settings/usage";

export const DEVIN_USAGE_COMMAND = {
  name: "usage",
  description: "Show this account's remaining Devin quota",
} as const;

export interface DevinUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsIn?: string;
}

export interface DevinUsage {
  readonly plan?: string;
  readonly windows: ReadonlyArray<DevinUsageWindow>;
  readonly extraBalance?: string;
}

/** The text a terminal app drew, with its cursor moves and colours taken out. */
export function devinScreenText(raw: string): string {
  return raw
    .replaceAll(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, " ")
    .replaceAll(/\u001b\[[0-9;?<>=]*[A-Za-z~]/g, " ")
    .replaceAll(/\u001b[()][0-9A-Za-z]|\u001b[=>78]/g, " ")
    .replaceAll(/\s+/g, " ");
}

/**
 * Reads the status line and `/usage` panel of Devin's terminal app, the only place Devin shows
 * an account's quota: its ACP agent answers `/usage` with "Unknown command".
 */
export function parseDevinUsage(screen: string): DevinUsage {
  const status = /([A-Za-z][\w+-]*) · (\d{1,3})% remaining(?: \(resets in ([^)]+)\))?/.exec(screen);
  const windows = Array.from(
    screen.matchAll(
      /\b(Daily|Weekly|Monthly)\b[^A-Za-z0-9]{0,400}?(\d{1,3})% used(?:[^A-Za-z0-9]{0,20}resets in ((?:\d+[wdhm] ?)+))?/g,
    ),
    ([, label, used, resetsIn]): DevinUsageWindow => ({
      label: label!,
      usedPercent: Math.min(100, Number(used)),
      ...(resetsIn ? { resetsIn: resetsIn.trim() } : {}),
    }),
  );
  const extraBalance = /Extra usage balance[^$\d]{0,40}(\$[\d,.]+)/.exec(screen)?.[1];
  return {
    ...(status?.[1] ? { plan: status[1] } : {}),
    windows:
      windows.length > 0 || status === null
        ? windows
        : [
            {
              label: "Quota",
              usedPercent: Math.max(0, 100 - Number(status[2])),
              ...(status[3] ? { resetsIn: status[3].trim() } : {}),
            },
          ],
    ...(extraBalance ? { extraBalance } : {}),
  };
}

function minutesUntilReset(resetsIn: string | undefined): number | undefined {
  if (resetsIn === undefined) return undefined;
  const parts = Array.from(resetsIn.matchAll(/(\d+)([wdhm])/g));
  if (parts.length === 0) return undefined;
  return parts.reduce((total, [, count, unit]) => total + Number(count) * MINUTES[unit!]!, 0);
}

const WINDOW_KINDS: Record<
  string,
  Pick<ServerProviderUsageWindow, "kind" | "windowDurationMins">
> = {
  Daily: { kind: "session", windowDurationMins: MINUTES.d },
  Weekly: { kind: "weekly", windowDurationMins: MINUTES.w },
  Monthly: { kind: "monthly" },
};

/** The account's windows, or a failed reading; either way with the page that has the figures. */
export function devinUsageLimits(
  usage: DevinUsage | undefined,
  now: number,
): ServerProviderUsageLimits {
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
  const limits =
    usage === undefined || usage.windows.length === 0
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Devin's app did not show this account's usage.",
        })
      : makeUsageLimits({
          checkedAt,
          windows: usage.windows.map((window) => {
            const minutes = minutesUntilReset(window.resetsIn);
            return {
              id: `devin_${window.label.toLowerCase()}`,
              label: `Devin ${window.label}`,
              ...(WINDOW_KINDS[window.label] ?? { kind: "other" as const }),
              usedPercent: window.usedPercent,
              ...(minutes === undefined
                ? {}
                : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + minutes * 60_000)) }),
            };
          }),
        });
  return { ...limits, externalUsage: { label: "Devin usage", url: DEVIN_USAGE_URL } };
}
export function formatDevinUsage(usage: DevinUsage | undefined, account?: string): string {
  if (usage === undefined || usage.windows.length === 0) {
    return "Devin did not report this account's usage. Its own app shows it under `/usage`.";
  }
  const heading = ["**Usage**", account, usage.plan && `${usage.plan} plan`].filter(Boolean);
  return [
    heading.join(" · "),
    "",
    "| Window | Used | Left | Resets |",
    "| --- | ---: | ---: | --- |",
    ...usage.windows.map(
      (window) =>
        `| ${window.label} | ${window.usedPercent}% | ${100 - window.usedPercent}% | ${window.resetsIn ? `in ${window.resetsIn}` : ""} |`,
    ),
    ...(usage.extraBalance ? ["", `Extra usage balance: ${usage.extraBalance}`] : []),
  ].join("\n");
}

/**
 * Opens Devin's terminal app with the instance's environment, asks it for `/usage` and reads
 * what it draws. It sends no prompt, so it starts no session and uses no model.
 */
export const readDevinUsage = Effect.fn("DevinUsage.read")(function* (input: {
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly command: string;
  readonly env: NodeJS.ProcessEnv | undefined;
}) {
  let raw = "";
  const output = yield* Queue.unbounded<string>();
  const drive = Effect.gen(function* () {
    const process = yield* input.pty.spawn({
      shell: input.command,
      // The app asks to trust an unknown folder before anything else; nothing here reads the folder.
      args: ["--respect-workspace-trust", "false"],
      cwd: NodeOS.tmpdir(),
      cols: 110,
      rows: 45,
      env: { ...input.env, TERM: "xterm-256color" },
    });
    const detach = process.onData((data) => {
      Queue.offerUnsafe(output, data);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detach();
        try {
          process.kill();
        } catch {}
      }),
    );
    let step: "starting" | "typed" | "asked" = "starting";
    let quietRounds = 0;
    while (quietRounds < MAX_QUIET_ROUNDS) {
      const chunk = yield* Queue.take(output).pipe(Effect.timeoutOption(QUIET));
      if (Option.isSome(chunk)) {
        raw += chunk.value;
        // The app waits for the terminal to answer where its cursor is and what it supports.
        if (chunk.value.includes("\u001b[6n")) process.write("\u001b[1;1R");
        if (chunk.value.includes("\u001b[c")) process.write("\u001b[?62;c");
        continue;
      }
      quietRounds += 1;
      const screen = devinScreenText(raw);
      if (step === "starting") {
        if (!screen.includes("% remaining") && quietRounds < MAX_QUIET_ROUNDS - 4) continue;
        process.write("/usage");
        step = "typed";
        quietRounds = 0;
      } else if (step === "typed") {
        process.write("\r");
        step = "asked";
        quietRounds = 0;
      } else if (/% used|No quota data available/.test(screen)) {
        return;
      }
    }
  });
  yield* drive.pipe(Effect.scoped, Effect.timeoutOption(READ_TIMEOUT), Effect.ignore);
  const usage = parseDevinUsage(devinScreenText(raw));
  return usage.windows.length === 0 ? undefined : usage;
});

const isUsageCommand = (prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>) =>
  prompt.length === 1 && prompt[0]?.type === "text" && prompt[0].text.trim() === "/usage";

/** Answers a `/usage` prompt with the account's quota, which Devin's ACP agent does not offer. */
export function withDevinUsageCommand(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  readUsage: Effect.Effect<DevinUsage | undefined>,
  account?: string,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const handlers: Array<Parameters<typeof runtime.handleSessionUpdate>[0]> = [];
  let replies = 0;
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        handlers.push(handler);
      }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
    prompt: (payload, options) =>
      !isUsageCommand(payload.prompt)
        ? runtime.prompt(payload, options)
        : Effect.gen(function* () {
            const { sessionId } = yield* runtime.start();
            if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
            const text = formatDevinUsage(yield* readUsage, account);
            replies += 1;
            const notification = {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: `t3-usage-${replies}`,
                content: { type: "text", text },
              },
            } satisfies EffectAcpSchema.SessionNotification;
            yield* Effect.forEach(handlers, (handler) => handler(notification), { discard: true });
            return { stopReason: "end_turn" } satisfies EffectAcpSchema.PromptResponse;
          }),
  };
}
