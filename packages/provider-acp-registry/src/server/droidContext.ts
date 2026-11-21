import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const Counted = Schema.Struct({ name: Schema.String, tokens: Schema.Number });

// Droid 1.16's `droid.get_context_breakdown`, the data behind `/context` in Factory's own apps.
const DroidContextBreakdown = Schema.Struct({
  modelDisplayName: Schema.String,
  contextBudget: Schema.Number,
  lastCallCompactionTokens: Schema.optional(Schema.Number),
  usedTokens: Schema.Number,
  freeTokens: Schema.Number,
  categories: Schema.Array(Counted),
  skills: Schema.optional(Schema.Array(Counted)),
  mcpServers: Schema.optional(
    Schema.Array(Schema.Struct({ ...Counted.fields, toolCount: Schema.Number })),
  ),
  droids: Schema.optional(Schema.Array(Counted)),
});
export type DroidContextBreakdown = typeof DroidContextBreakdown.Type;

const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);
const decodeBreakdown = Schema.decodeUnknownOption(DroidContextBreakdown);

export const DROID_CONTEXT_COMMAND = {
  name: "context",
  description: "Show what fills the context window",
} as const;

const READ_TIMEOUT = "30 seconds";
const MAX_LISTED = 12;

const scaled = (value: number, unit: string) => `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
const tokens = (value: number) =>
  value >= 999_950
    ? scaled(value / 1_000_000, "m")
    : value >= 1_000
      ? scaled(value / 1_000, "k")
      : String(Math.round(value));

const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export function formatDroidContextBreakdown(breakdown: DroidContextBreakdown): string {
  const budget = Math.max(breakdown.contextBudget, 1);
  const share = (value: number) => `${((value / budget) * 100).toFixed(1)}%`;
  const listed = (
    title: string,
    items: ReadonlyArray<{ readonly name: string; readonly tokens: number }> | undefined,
    detail: (item: { readonly name: string; readonly tokens: number }) => string = () => "",
  ) => {
    const used = (items ?? []).filter((item) => item.tokens > 0);
    if (used.length === 0) return [];
    const shown = used
      .toSorted((a, b) => b.tokens - a.tokens)
      .slice(0, MAX_LISTED)
      .map((item) => `${cell(item.name)} ${tokens(item.tokens)}${detail(item)}`);
    const more = used.length > MAX_LISTED ? [`${used.length - MAX_LISTED} more`] : [];
    return ["", `**${title}:** ${[...shown, ...more].join(" · ")}`];
  };
  const toolCounts = new Map(
    (breakdown.mcpServers ?? []).map((server) => [server.name, server.toolCount]),
  );
  return [
    `**Context** · ${cell(breakdown.modelDisplayName)} · ${tokens(breakdown.usedTokens)} of ${tokens(breakdown.contextBudget)} tokens (${share(breakdown.usedTokens)})`,
    "",
    "| Category | Tokens | Share |",
    "| --- | ---: | ---: |",
    ...breakdown.categories
      .filter((category) => category.tokens > 0)
      .map(
        (category) =>
          `| ${cell(category.name)} | ${tokens(category.tokens)} | ${share(category.tokens)} |`,
      ),
    `| Free space | ${tokens(breakdown.freeTokens)} | ${share(breakdown.freeTokens)} |`,
    ...listed("MCP servers", breakdown.mcpServers, (server) => {
      const count = toolCounts.get(server.name) ?? 0;
      return ` (${count} ${count === 1 ? "tool" : "tools"})`;
    }),
    ...listed("Skills", breakdown.skills),
    ...listed("Custom droids", breakdown.droids),
    "",
    breakdown.lastCallCompactionTokens === undefined
      ? `Sizes are Droid's estimates. Droid compacts the conversation at ${tokens(breakdown.contextBudget)} tokens.`
      : `Sizes are Droid's estimates. The last model call used ${tokens(breakdown.lastCallCompactionTokens)} tokens, and Droid compacts the conversation at ${tokens(breakdown.contextBudget)}.`,
  ].join("\n");
}

const isTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const failed = (detail: string, cause?: unknown) =>
  new EffectAcpErrors.AcpTransportError({ detail, cause });

const request = (id: string, method: string, params: unknown) =>
  `${JSON.stringify({
    factoryApiVersion: "1.0.0",
    factoryProtocolVersion: "1.0.0",
    type: "request",
    jsonrpc: "2.0",
    id,
    method,
    params,
  })}\n`;

/**
 * Droid answers no built-in command over ACP, so a second Droid reads the session through
 * Droid's own protocol. It only reads: the session's files are left as they are.
 */
export const readDroidContextBreakdown = Effect.fn("DroidContext.readBreakdown")(function* (input: {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string;
  readonly sessionId: string;
}) {
  const read = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          input.command,
          [
            "exec",
            "--input-format",
            "stream-jsonrpc",
            "--output-format",
            "stream-jsonrpc",
            "--cwd",
            input.cwd,
          ],
          {
            cwd: input.cwd,
            ...(input.env ? { env: input.env } : {}),
            extendEnv: true,
            stdin: { stream: "pipe", endOnDone: false },
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          },
        ),
      )
      .pipe(
        Effect.mapError((cause) => failed("Could not start Droid to read the context.", cause)),
      );
    const outgoing = yield* Queue.unbounded<string>();
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.encodeText,
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Queue.offer(
      outgoing,
      request("load", "droid.load_session", { sessionId: input.sessionId }),
    );
    const reply = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) => {
        const message = Option.getOrUndefined(decodeReply(line));
        if (message?.id === undefined) return Effect.undefined;
        if (message.error !== undefined) return Effect.fail(failed(message.error.message));
        if (message.id === "breakdown") return Effect.succeed(message.result);
        return Queue.offer(outgoing, request("breakdown", "droid.get_context_breakdown", {})).pipe(
          Effect.as(undefined),
        );
      }),
      Stream.filter((result) => result !== undefined),
      Stream.runHead,
      Effect.mapError((cause) =>
        isTransportError(cause)
          ? cause
          : failed("Droid stopped before it reported the context.", cause),
      ),
    );
    const breakdown = Option.flatMap(reply, decodeBreakdown);
    if (Option.isNone(breakdown)) {
      return yield* failed("Droid did not report the context in the expected shape.");
    }
    return breakdown.value;
  });
  return yield* read.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: READ_TIMEOUT,
      orElse: () => Effect.fail(failed("Droid did not report the context in time.")),
    }),
  );
});

const isContextCommand = (prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>) =>
  prompt.length === 1 && prompt[0]?.type === "text" && prompt[0].text.trim() === "/context";

/** Answers a `/context` prompt as a reply from Droid's own figures, without a model call. */
export function withDroidContextCommand(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  readContext: (
    sessionId: string,
  ) => Effect.Effect<DroidContextBreakdown, EffectAcpErrors.AcpError>,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const handlers: Array<
    (
      notification: EffectAcpSchema.SessionNotification,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>
  > = [];
  let replies = 0;
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        handlers.push(handler);
      }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
    prompt: (payload, options) =>
      !isContextCommand(payload.prompt)
        ? runtime.prompt(payload, options)
        : Effect.gen(function* () {
            const { sessionId } = yield* runtime.start();
            if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
            const text = yield* readContext(sessionId).pipe(
              Effect.map(formatDroidContextBreakdown),
              Effect.catch((error) =>
                Effect.succeed(
                  `Droid could not report its context usage. ${error._tag === "AcpTransportError" ? (error.detail ?? "") : ""}`.trim(),
                ),
              ),
            );
            replies += 1;
            const notification = {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: `t3-context-${replies}`,
                content: { type: "text", text },
              },
            } satisfies EffectAcpSchema.SessionNotification;
            yield* Effect.forEach(handlers, (handler) => handler(notification), { discard: true });
            return { stopReason: "end_turn" } satisfies EffectAcpSchema.PromptResponse;
          }),
  };
}
