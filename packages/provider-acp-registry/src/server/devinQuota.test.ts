import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

import {
  devinQuotaFailure,
  devinQuotaResetAt,
  withDevinQuota,
  type DevinQuotaRuntime,
} from "./devinQuota.ts";
import type { DevinUsage } from "./devinUsage.ts";

// The error Devin's own `/debug-echo` help gives as its quota example (Devin 3000.14).
const quotaError = (data: Record<string, unknown> = {}) =>
  new AcpErrors.AcpRequestError({
    code: -32011,
    errorMessage: "Quota exhausted.",
    data: {
      "cognition.ai/errorKind": "resource_exhausted",
      "cognition.ai/retryable": true,
      ...data,
    },
    method: "session/prompt",
  });
const ordinaryError = new AcpErrors.AcpRequestError({
  code: -32011,
  errorMessage: "The model is unavailable.",
  data: { "cognition.ai/errorKind": "unavailable", "cognition.ai/retryable": true },
  method: "session/prompt",
});
// Recorded from Devin 3000.14: what precedes every prompt result, here with the quota cause.
const agentStopped = (cause: string, sessionId = "educated-chatter") => ({
  cause,
  ...(cause === "complete" ? {} : { errorMessage: "Quota exhausted: weekly quota used up." }),
  stats: { toolCalls: 0, filesChanged: 0, commandsRun: 0, inputTokens: 14_601, outputTokens: 0 },
  sessionId,
});
const endTurn = { stopReason: "end_turn" } satisfies AcpSchema.PromptResponse;
const exhausted: DevinUsage = {
  plan: "Max",
  windows: [
    { label: "Daily", usedPercent: 100, resetsIn: "5h 2m" },
    { label: "Weekly", usedPercent: 100, resetsIn: "1d 3h" },
    { label: "Monthly", usedPercent: 40, resetsIn: "2w 1d" },
  ],
};
const PROMPT = { prompt: [{ type: "text" as const, text: "hello" }] };

/** A runtime whose prompts play `turns` in order; a turn may emit ext notifications first. */
const makeRuntime = (
  turns: ReadonlyArray<
    (
      emit: (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>,
    ) => Effect.Effect<AcpSchema.PromptResponse, AcpErrors.AcpError>
  >,
  reading: () => DevinUsage | undefined = () => exhausted,
) => {
  const handlers = new Map<string, (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>>();
  const state = { prompts: 0, readings: 0 };
  const runtime: DevinQuotaRuntime = {
    start: () => Effect.succeed({ sessionId: "educated-chatter" }),
    handleExtNotification: (method, payload, handler) =>
      Effect.sync(() => {
        handlers.set(method, (params) =>
          Schema.decodeUnknownEffect(payload)(params).pipe(Effect.orDie, Effect.flatMap(handler)),
        );
      }),
    prompt: () =>
      Effect.suspend(() => {
        state.prompts += 1;
        return turns[state.prompts - 1]!(
          (params) => handlers.get("_cognition.ai/agent_stopped")?.(params) ?? Effect.void,
        );
      }),
  };
  return Effect.map(
    withDevinQuota(
      runtime,
      Effect.sync(() => {
        state.readings += 1;
        return reading();
      }),
    ),
    (wrapped) => ({ state, prompt: wrapped.prompt(PROMPT) }),
  );
};

describe("Devin quota", () => {
  it("maps a used-up quota to a usage limit and leaves every other error alone", () => {
    expect(devinQuotaFailure(quotaError({ "t3code/resetAt": "2026-11-22T08:00:00.000Z" }))).toEqual(
      {
        class: "usage_limit",
        message: "Quota exhausted.",
        code: "-32011",
        retryable: true,
        resetAt: "2026-11-22T08:00:00.000Z",
      },
    );
    expect(devinQuotaFailure(quotaError())).toEqual({
      class: "usage_limit",
      message: "Quota exhausted.",
      code: "-32011",
      retryable: true,
    });
    expect(devinQuotaFailure(ordinaryError)).toBeUndefined();
    expect(
      devinQuotaFailure(
        new AcpErrors.AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
      ),
    ).toBeUndefined();
    expect(devinQuotaFailure(new Error("Quota exhausted."))).toBeUndefined();
  });

  it("takes the reset time from the last used-up window to come back", () => {
    const now = Date.UTC(2026, 10, 21, 5, 0, 0);
    expect(devinQuotaResetAt(exhausted, now)).toBe("2026-11-22T08:00:00.000Z");
    expect(
      devinQuotaResetAt(
        { windows: [{ label: "Weekly", usedPercent: 97, resetsIn: "1d 3h" }] },
        now,
      ),
    ).toBeUndefined();
    expect(devinQuotaResetAt({ windows: [{ label: "Weekly", usedPercent: 100 }] }, now)).toBe(
      undefined,
    );
    expect(devinQuotaResetAt(undefined, now)).toBeUndefined();
  });

  it.effect("gives a quota error the reset time of a fresh reading", () =>
    Effect.gen(function* () {
      const { state, prompt } = yield* makeRuntime([() => Effect.fail(quotaError())]);
      expect(devinQuotaFailure(yield* Effect.flip(prompt))).toMatchObject({
        class: "usage_limit",
        message: "Quota exhausted.",
        resetAt: "1970-01-02T03:00:00.000Z",
      });
      expect(state.readings).toBe(1);
    }),
  );

  it.effect("fails a prompt that ends normally after Devin stopped on its quota", () =>
    Effect.gen(function* () {
      const stopThenEnd = (cause: string, sessionId?: string) =>
        [
          (emit: (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>) =>
            emit(agentStopped(cause, sessionId)).pipe(Effect.as(endTurn)),
        ] as const;
      const quota = yield* makeRuntime([
        ...stopThenEnd("quota_exhausted"),
        // The stop of an earlier prompt says nothing about the next one.
        () => Effect.succeed(endTurn),
      ]);
      expect(devinQuotaFailure(yield* Effect.flip(quota.prompt))).toEqual({
        class: "usage_limit",
        message: "Quota exhausted: weekly quota used up.",
        code: "-32011",
        retryable: null,
        resetAt: "1970-01-02T03:00:00.000Z",
      });
      expect(yield* quota.prompt).toEqual(endTurn);

      const complete = yield* makeRuntime(stopThenEnd("complete"));
      expect(yield* complete.prompt).toEqual(endTurn);
      const otherSession = yield* makeRuntime(stopThenEnd("quota_exhausted", "a-sub-agent"));
      expect(yield* otherSession.prompt).toEqual(endTurn);
      expect(complete.state.readings + otherSession.state.readings).toBe(0);
    }),
  );

  it.effect("reads the quota for no other failure, and not for a short rate limit", () =>
    Effect.gen(function* () {
      const ordinary = yield* makeRuntime([() => Effect.fail(ordinaryError)]);
      expect(yield* Effect.flip(ordinary.prompt)).toBe(ordinaryError);
      expect(ordinary.state.readings).toBe(0);

      const rateLimited = yield* makeRuntime([
        () => Effect.fail(quotaError({ "cognition.ai/retryAfterSeconds": 90 })),
      ]);
      expect(devinQuotaFailure(yield* Effect.flip(rateLimited.prompt))).toMatchObject({
        class: "usage_limit",
        resetAt: "1970-01-01T00:01:30.000Z",
      });
      expect(rateLimited.state.readings).toBe(0);
    }),
  );

  it.effect("reports the usage limit without a reset time when the reading fails", () =>
    Effect.gen(function* () {
      const { prompt } = yield* makeRuntime([() => Effect.fail(quotaError())], () => undefined);
      const failure = devinQuotaFailure(yield* Effect.flip(prompt));
      expect(failure).toMatchObject({ class: "usage_limit", message: "Quota exhausted." });
      expect(failure).not.toHaveProperty("resetAt");
    }),
  );
});
