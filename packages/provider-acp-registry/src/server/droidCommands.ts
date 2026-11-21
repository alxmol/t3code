import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import {
  cell,
  droidContextUse,
  formatDroidContextBreakdown,
  readDroidContextBreakdown,
  tokens,
  type DroidContextBreakdown,
} from "./droidContext.ts";
import {
  droidFailed,
  droidFailureDetail,
  type AskDroidSession,
  type DroidSession,
} from "./droidSession.ts";

const TokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cacheCreationTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  thinkingTokens: Schema.optional(Schema.Number),
  factoryCredits: Schema.optional(Schema.Number),
});
type TokenUsage = typeof TokenUsage.Type;

// The fields of Droid 1.16's `droid.load_session` reply behind its own `/cost` and `/status`.
const DroidLoadedSession = Schema.Struct({
  session: Schema.optional(Schema.Struct({ title: Schema.optional(Schema.NullOr(Schema.String)) })),
  settings: Schema.optional(
    Schema.Struct({
      reasoningEffort: Schema.optional(Schema.String),
      autonomyMode: Schema.optional(Schema.String),
    }),
  ),
  cwd: Schema.optional(Schema.String),
  tokenUsage: Schema.optional(TokenUsage),
  inclusiveTokenUsage: Schema.optional(TokenUsage),
  lastCallTokenUsage: Schema.optional(TokenUsage),
});
export type DroidLoadedSession = typeof DroidLoadedSession.Type;

const DroidMcpServers = Schema.Struct({
  servers: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
});
type DroidMcpServers = typeof DroidMcpServers.Type;

const decodeLoaded = Schema.decodeUnknownOption(DroidLoadedSession);
const decodeMcpServers = Schema.decodeUnknownOption(DroidMcpServers);
const decodeBackgroundWork = Schema.decodeUnknownOption(
  Schema.Struct({ backgroundWork: Schema.optional(Schema.Number) }),
);
const decodeCompacted = Schema.decodeUnknownOption(
  Schema.Struct({ newSessionId: Schema.String, removedCount: Schema.Number }),
);

const COMPACT_TIMEOUT = "10 minutes";
const DROID_COMPACT_REQUEST = "t3/droid/compact";

const DROID_COMMANDS = [
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "context", description: "Show what fills the context window" },
  { name: "cost", description: "Show the tokens this session has used" },
  { name: "status", description: "Show the session's model, settings and context" },
] as const;

/** Adds the commands T3 answers for Droid, after Droid's own: a name Droid advertises stays its. */
export function withDroidSlashCommands<Command extends { readonly name: string }>(
  commands: ReadonlyArray<Command>,
): Array<Command | (typeof DROID_COMMANDS)[number]> {
  const advertised = new Set(commands.map((command) => command.name.trim().toLowerCase()));
  return [...commands, ...DROID_COMMANDS.filter((command) => !advertised.has(command.name))];
}

const total = (usage: TokenUsage) =>
  (usage.inputTokens ?? 0) +
  (usage.outputTokens ?? 0) +
  (usage.cacheCreationTokens ?? 0) +
  (usage.cacheReadTokens ?? 0);
const count = (value: number | undefined) => (value === undefined ? "–" : tokens(value));

export function formatDroidCost(loaded: DroidLoadedSession): string {
  const session = loaded.tokenUsage;
  if (session === undefined) return "Droid has recorded no token usage for this session yet.";
  const inclusive = loaded.inclusiveTokenUsage ?? session;
  const credits = inclusive.factoryCredits ?? session.factoryCredits;
  const row = (label: string, usage: TokenUsage) =>
    `| ${[
      label,
      count(usage.inputTokens),
      count(usage.outputTokens),
      count(usage.cacheCreationTokens),
      count(usage.cacheReadTokens),
      count(usage.thinkingTokens),
      ...(credits === undefined ? [] : [count(usage.factoryCredits)]),
    ].join(" | ")} |`;
  const columns = credits === undefined ? 5 : 6;
  return [
    `**Cost** · ${tokens(total(inclusive))} tokens${credits === undefined ? "" : ` · ${tokens(credits)} Factory credits`}`,
    "",
    `| Usage | Input | Output | Cache write | Cache read | Thinking |${credits === undefined ? "" : " Credits |"}`,
    `| --- |${" ---: |".repeat(columns)}`,
    row("This session", session),
    ...(Object.entries(inclusive).some(([key, value]) => value !== session[key as keyof TokenUsage])
      ? [row("With sub-agents", inclusive)]
      : []),
    ...(loaded.lastCallTokenUsage === undefined
      ? []
      : [row("Last model call", loaded.lastCallTokenUsage)]),
    "",
    credits === undefined
      ? "These are Droid's own token counts for this session, not a price."
      : "These are Droid's own counts of tokens and Factory credits for this session, not a price.",
  ].join("\n");
}

export function formatDroidStatus(status: {
  readonly version: string | undefined;
  readonly sessionId: string;
  readonly autonomyLevel: string | undefined;
  readonly loaded: DroidLoadedSession;
  readonly breakdown: DroidContextBreakdown;
  readonly mcpServers: DroidMcpServers["servers"];
}): string {
  const title = status.loaded.session?.title?.trim();
  const servers = status.mcpServers.map((server) =>
    server.status === "failed" || server.status === "disabled"
      ? `${server.name} (${server.status})`
      : server.name,
  );
  const rows: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Model", status.breakdown.modelDisplayName],
    ["Reasoning effort", status.loaded.settings?.reasoningEffort],
    ["Autonomy level", status.autonomyLevel ?? status.loaded.settings?.autonomyMode],
    ["Working directory", status.loaded.cwd],
    ["Session", title ? `${title} · ${status.sessionId}` : status.sessionId],
    ["Context", droidContextUse(status.breakdown)],
    [
      "MCP servers",
      servers.length === 0
        ? "none"
        : `${servers.length} in Droid's settings: ${servers.join(", ")}`,
    ],
  ];
  return [
    `**Status** · Droid${status.version ? ` ${cell(status.version)}` : ""}`,
    "",
    "| Setting | Value |",
    "| --- | --- |",
    ...rows.flatMap(([label, value]) => (value ? [`| ${label} | ${cell(value)} |`] : [])),
  ].join("\n");
}

const loadedSession = (session: DroidSession) =>
  Effect.fromOption(decodeLoaded(session.loaded)).pipe(
    Effect.mapError(() => droidFailed("Droid did not report the session in the expected shape.")),
  );

const readDroidStatus = Effect.fn("DroidCommands.readStatus")(function* (session: DroidSession) {
  const servers = decodeMcpServers(yield* session.request("droid.list_mcp_servers", {}));
  return {
    loaded: yield* loadedSession(session),
    breakdown: yield* readDroidContextBreakdown(session),
    mcpServers: Option.isSome(servers) ? servers.value.servers : [],
  };
});

/**
 * Droid's ACP `usage_update` is the last model call's input, which runs above its estimate of
 * the context. The compacted figure is that input less what the estimate lost, so the meter
 * agrees with what Droid reports after the next prompt.
 */
export function droidUsageAfterCompaction(
  before: DroidContextBreakdown | undefined,
  after: DroidContextBreakdown,
): number {
  const lastCall = before?.lastCallCompactionTokens;
  if (before === undefined || lastCall === undefined) return after.usedTokens;
  return Math.max(after.usedTokens, lastCall - Math.max(before.usedTokens - after.usedTokens, 0));
}

/** In place: Droid's `handoff` mode would move the conversation to a session T3 does not hold. */
const compactDroidSession = (sessionId: string) =>
  Effect.fn("DroidCommands.compactSession")(function* (session: DroidSession) {
    // A second Droid cannot see a running Task's turn, and nothing in Droid stops the race.
    const background = decodeBackgroundWork(
      yield* session.request("droid.get_background_work", { sessionId }),
    );
    if (Option.isSome(background) && (background.value.backgroundWork ?? 0) > 0) {
      return yield* droidFailed(
        "Droid is still running background work in this conversation. Compact it once that has finished.",
      );
    }
    const before = yield* readDroidContextBreakdown(session).pipe(Effect.option);
    const compacted = decodeCompacted(yield* session.request("droid.compact_session", {}));
    if (Option.isNone(compacted) || compacted.value.newSessionId !== sessionId) {
      return yield* droidFailed("Droid did not confirm that it compacted this conversation.");
    }
    const after = yield* readDroidContextBreakdown(session).pipe(Effect.option);
    return Option.map(after, (breakdown) => ({
      used: droidUsageAfterCompaction(Option.getOrUndefined(before), breakdown),
      size: breakdown.contextBudget,
    }));
  });

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

const ANSWERS: Readonly<
  Record<
    string,
    {
      readonly failure: string;
      readonly answer: (input: {
        readonly runtime: Runtime;
        readonly ask: AskDroidSession;
        readonly sessionId: string;
      }) => Effect.Effect<string, EffectAcpErrors.AcpError>;
    }
  >
> = {
  context: {
    failure: "Droid could not report its context usage.",
    answer: ({ ask, sessionId }) =>
      ask(sessionId, readDroidContextBreakdown).pipe(Effect.map(formatDroidContextBreakdown)),
  },
  cost: {
    failure: "Droid could not report its token usage.",
    answer: ({ ask, sessionId }) => ask(sessionId, loadedSession).pipe(Effect.map(formatDroidCost)),
  },
  status: {
    failure: "Droid could not report its status.",
    answer: Effect.fnUntraced(function* ({ runtime, ask, sessionId }) {
      const status = yield* ask(sessionId, readDroidStatus);
      const modes = yield* runtime.getModeState;
      return formatDroidStatus({
        ...status,
        sessionId,
        version: (yield* runtime.start()).initializeResult.agentInfo?.version,
        autonomyLevel: modes?.availableModes.find((mode) => mode.id === modes.currentModeId)?.name,
      });
    }),
  },
};

const commandName = (prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>) => {
  const text = prompt.length === 1 && prompt[0]?.type === "text" ? prompt[0].text.trim() : "";
  return text.startsWith("/") ? text.slice(1) : undefined;
};

/** The flavor's hook is given only the runtime; `withDroidCommands` answers this request on it. */
export const droidCompactSession: NonNullable<AcpAdapterV2Flavor["compactSession"]> = {
  supported: () => true,
  compact: (runtime, sessionId) =>
    runtime.request(DROID_COMPACT_REQUEST, { sessionId }).pipe(Effect.asVoid),
};

/**
 * Answers Droid's built-in commands, which Droid passes to the model as chat over ACP, from a
 * second Droid on the same session: read-only ones as a reply, `/compact` as a compaction.
 */
export function withDroidCommands(runtime: Runtime, ask: AskDroidSession): Runtime {
  const handlers: Array<Parameters<Runtime["handleSessionUpdate"]>[0]> = [];
  const emit = (sessionId: string, update: EffectAcpSchema.SessionNotification["update"]) =>
    Effect.forEach(handlers, (handler) => handler({ sessionId, update }), { discard: true });
  let advertised: ReadonlySet<string> = new Set();
  const compact = Effect.fn("DroidCommands.compact")(function* () {
    const { sessionId } = yield* runtime.start();
    // Item ids come from these ids, and a counter would restart with the runtime.
    const compactionId = `t3-compact-${yield* Clock.currentTimeMillis}`;
    yield* emit(sessionId, { sessionUpdate: "compaction_update", compactionId, status: "running" });
    const compacted = yield* ask(sessionId, compactDroidSession(sessionId), {
      timeout: COMPACT_TIMEOUT,
      awaitExit: true,
    }).pipe(Effect.result);
    if (compacted._tag === "Failure") {
      yield* emit(sessionId, {
        sessionUpdate: "compaction_update",
        compactionId,
        status: "failed",
        error: droidFailureDetail(compacted.failure) || "Droid could not compact the conversation.",
      });
      return;
    }
    yield* emit(sessionId, {
      sessionUpdate: "compaction_update",
      compactionId,
      status: "completed",
    });
    // Droid's ACP process reports usage again only with its next prompt.
    if (Option.isSome(compacted.success)) {
      yield* emit(sessionId, { sessionUpdate: "usage_update", ...compacted.success.value });
    }
  });
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        handlers.push(handler);
      }).pipe(
        Effect.andThen(
          runtime.handleSessionUpdate((notification) => {
            if (notification.update.sessionUpdate === "available_commands_update") {
              advertised = new Set(
                notification.update.availableCommands.map((command) =>
                  command.name.trim().toLowerCase(),
                ),
              );
            }
            return handler(notification);
          }),
        ),
      ),
    request: (method, payload) =>
      method === DROID_COMPACT_REQUEST ? compact() : runtime.request(method, payload),
    prompt: (payload, options) => {
      const name = commandName(payload.prompt);
      const command =
        name === undefined || advertised.has(name) || !Object.hasOwn(ANSWERS, name)
          ? undefined
          : ANSWERS[name];
      if (command === undefined) return runtime.prompt(payload, options);
      return Effect.gen(function* () {
        const { sessionId } = yield* runtime.start();
        if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
        const text = yield* command
          .answer({ runtime, ask, sessionId })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(`${command.failure} ${droidFailureDetail(error)}`.trim()),
            ),
          );
        yield* emit(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: `t3-${name}-${yield* Clock.currentTimeMillis}`,
          content: { type: "text", text },
        });
        return { stopReason: "end_turn" } satisfies EffectAcpSchema.PromptResponse;
      });
    },
  };
}
