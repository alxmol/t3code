import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import { devinUsageLimits, type DevinUsage } from "./devinUsage.ts";

// Devin's code for every agent error; the kind in its data tells a used-up quota from the rest.
const DEVIN_AGENT_ERROR_CODE = -32011;
const ERROR_KIND = "cognition.ai/errorKind";
const RETRYABLE = "cognition.ai/retryable";
const RETRY_AFTER_SECONDS = "cognition.ai/retryAfterSeconds";
const QUOTA_KIND = "resource_exhausted";
const AGENT_STOPPED = "_cognition.ai/agent_stopped";
// Devin names no reset time, so the runtime wrapper writes the one it read under this key.
const RESET_AT = "t3code/resetAt";

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isDevinQuotaError(cause: unknown): cause is AcpErrors.AcpRequestError {
  return isAcpRequestError(cause) && record(cause.data)?.[ERROR_KIND] === QUOTA_KIND;
}

/** A used-up quota or rate limit as T3's usage limit; `undefined` for every other failure. */
export function devinQuotaFailure(cause: unknown) {
  if (!isDevinQuotaError(cause)) return undefined;
  const data = record(cause.data);
  const retryable = data?.[RETRYABLE];
  const resetAt = data?.[RESET_AT];
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: String(cause.code),
    class: "usage_limit",
    retryable: typeof retryable === "boolean" ? retryable : null,
    ...(typeof resetAt === "string" ? { resetAt } : {}),
  });
}

/** Quota is back when the last used-up window resets. */
export function devinQuotaResetAt(usage: DevinUsage | undefined, now: number): string | undefined {
  return devinUsageLimits(usage, now)
    .windows.flatMap((window) =>
      window.usedPercent >= 100 && window.resetsAt !== undefined ? [window.resetsAt] : [],
    )
    .toSorted()
    .at(-1);
}

export interface DevinQuotaRuntime {
  readonly start: () => Effect.Effect<{ readonly sessionId: string }, AcpErrors.AcpError>;
  readonly prompt: AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"];
  readonly handleExtNotification: AcpSessionRuntime.AcpSessionRuntime["Service"]["handleExtNotification"];
}

/**
 * Ends a prompt that ran out of quota as one quota error carrying the time the quota is back.
 * Devin may reject the prompt, or report `agent_stopped` with the cause and then answer it.
 */
export const withDevinQuota = Effect.fn("DevinQuota.withDevinQuota")(function* <
  Runtime extends DevinQuotaRuntime,
>(runtime: Runtime, readUsage: Effect.Effect<DevinUsage | undefined>) {
  const quotaStops: Array<{
    readonly sessionId: string | undefined;
    readonly message: string | undefined;
  }> = [];
  yield* runtime.handleExtNotification(AGENT_STOPPED, Schema.Unknown, (params) =>
    Effect.sync(() => {
      const stopped = record(params);
      if (stopped?.cause !== "quota_exhausted") return;
      quotaStops.push({
        sessionId: typeof stopped.sessionId === "string" ? stopped.sessionId : undefined,
        message:
          typeof stopped.errorMessage === "string" && stopped.errorMessage.trim().length > 0
            ? stopped.errorMessage
            : undefined,
      });
    }),
  );
  const failWithResetAt = Effect.fn("DevinQuota.failWithResetAt")(function* (
    error: AcpErrors.AcpRequestError,
  ) {
    const data = record(error.data);
    const retryAfter = data?.[RETRY_AFTER_SECONDS];
    // A rate limit says when to retry; only a used-up quota needs the slow read of Devin's app.
    const rateLimited = typeof retryAfter === "number" && retryAfter > 0;
    const usage = rateLimited ? undefined : yield* readUsage;
    const now = yield* Clock.currentTimeMillis;
    const resetAt = rateLimited
      ? DateTime.formatIso(DateTime.makeUnsafe(now + retryAfter * 1_000))
      : devinQuotaResetAt(usage, now);
    return yield* new AcpErrors.AcpRequestError({
      code: error.code,
      errorMessage: error.errorMessage,
      data: { ...data, ...(resetAt === undefined ? {} : { [RESET_AT]: resetAt }) },
      method: error.method ?? "session/prompt",
    });
  });
  const prompt = Effect.fn("DevinQuota.prompt")(function* (
    payload: Parameters<DevinQuotaRuntime["prompt"]>[0],
    options?: Parameters<DevinQuotaRuntime["prompt"]>[1],
  ) {
    quotaStops.length = 0;
    const result = yield* runtime
      .prompt(payload, options)
      .pipe(Effect.catchIf(isDevinQuotaError, failWithResetAt));
    const stopped = quotaStops.at(-1);
    if (
      stopped === undefined ||
      (stopped.sessionId !== undefined && stopped.sessionId !== (yield* runtime.start()).sessionId)
    ) {
      return result;
    }
    return yield* failWithResetAt(
      new AcpErrors.AcpRequestError({
        code: DEVIN_AGENT_ERROR_CODE,
        errorMessage: stopped.message ?? "Quota exhausted.",
        data: { [ERROR_KIND]: QUOTA_KIND },
        method: "session/prompt",
      }),
    );
  });
  return { ...runtime, prompt };
});
