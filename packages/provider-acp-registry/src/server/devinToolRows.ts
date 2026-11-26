import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const MAX_TRACKED = 64;
const MAX_OUTPUT_CHARS = 320 * 1024;

type Notification = EffectAcpSchema.SessionNotification;

interface TerminalRun {
  readonly command: string;
  readonly output: string;
  readonly exited: boolean;
  readonly exitCode?: number | null | undefined;
}

interface HeldSubagentCall {
  readonly task: unknown;
  readonly notifications: ReadonlyArray<Notification>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function remember<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_TRACKED) break;
    map.delete(oldest);
  }
}

/**
 * Devin runs a command in the client's terminal and reports only "Exited with code N", and it
 * reports a sub-agent twice: as its `run_subagent` call and as the sub-agent itself.
 */
export function makeDevinToolRows() {
  const titles = new Map<string, string>();
  const commands = new Map<string, string>();
  const terminals = new Map<string, TerminalRun>();
  const ownRuns = new Map<string, { readonly output: string; readonly exitCode?: number }>();
  const heldSubagentCalls = new Map<string, HeldSubagentCall>();
  const shownAsSubagent = new Map<string, true>();
  const reportedAgents = new Map<string, true>();

  const claimSubagentCall = (started: Record<string, unknown>): void => {
    if (typeof started.agentId !== "string" || reportedAgents.has(started.agentId)) return;
    remember(reportedAgents, started.agentId, true);
    const held = Array.from(heldSubagentCalls);
    const call =
      held.find(([, candidate]) => candidate.task === started.task) ??
      (held.length === 1 ? held[0] : undefined);
    if (call === undefined) return;
    heldSubagentCalls.delete(call[0]);
    remember(shownAsSubagent, call[0], true);
  };

  return {
    terminalCreated: (terminalId: string, command: string): void =>
      remember(terminals, terminalId, { command, output: "", exited: false }),
    terminalOutput: (
      terminalId: string,
      response: EffectAcpSchema.TerminalOutputResponse,
    ): void => {
      const run = terminals.get(terminalId);
      if (run === undefined) return;
      terminals.set(terminalId, {
        command: run.command,
        output: response.output,
        exited: response.exitStatus != null,
        exitCode: response.exitStatus?.exitCode,
      });
    },
    /** Terminals of commands Devin has not reported as ended. */
    runningCommandTerminals: (): ReadonlyArray<string> => {
      const running = new Set(commands.values());
      return Array.from(terminals).flatMap(([terminalId, run]) =>
        !run.exited && running.has(run.command) ? [terminalId] : [],
      );
    },
    project: (notification: Notification): ReadonlyArray<Notification> => {
      const update = notification.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return [notification];
      }
      const meta = record(update._meta);
      const started = record(meta?.["cognition.ai/subagent_started"]);
      if (started !== undefined) {
        claimSubagentCall(started);
        return [notification];
      }
      const toolCallId = update.toolCallId;
      const knownTitle = titles.get(toolCallId);
      if (typeof update.title === "string" && update.title.length > 0) {
        remember(titles, toolCallId, update.title);
      }
      // T3 names a sub-agent's tool from each update alone; one without a title would rename it.
      const titledUpdate =
        update.title == null && knownTitle !== undefined
          ? { ...update, title: knownTitle }
          : update;
      const titled = { ...notification, update: titledUpdate };
      const toolName = meta?.["cognition.ai/inferenceToolName"];
      const ended = update.status === "completed" || update.status === "failed";
      if (toolName === "run_subagent") {
        if (shownAsSubagent.has(toolCallId)) {
          if (ended) shownAsSubagent.delete(toolCallId);
          return update.status === "failed" ? [titled] : [];
        }
        // Held until Devin reports the sub-agent, so a call that never starts one still shows.
        const held = heldSubagentCalls.get(toolCallId);
        const notifications = [...(held?.notifications ?? []), titled];
        heldSubagentCalls.delete(toolCallId);
        if (ended) return notifications;
        remember(heldSubagentCalls, toolCallId, {
          task: record(update.rawInput)?.task ?? held?.task,
          notifications,
        });
        return [];
      }
      if (toolName !== "exec") return [titled];
      const command = record(update.rawInput)?.command;
      if (typeof command === "string") remember(commands, toolCallId, command);
      // Devin 3000.15 runs the command itself: the output so far as text, then `terminal_exit`.
      const exit = record(meta?.terminal_exit);
      if (exit !== undefined || meta?.["cognition.ai/terminalPreview"] === true) {
        const exitCode = typeof exit?.exit_code === "number" ? exit.exit_code : undefined;
        const output =
          update.content == null
            ? (ownRuns.get(toolCallId)?.output ?? "")
            : update.content
                .flatMap((part) =>
                  part.type === "content" && part.content.type === "text"
                    ? [part.content.text]
                    : [],
                )
                .join("");
        remember(ownRuns, toolCallId, {
          output,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      }
      if (!ended) return [titled];
      const ran = commands.get(toolCallId);
      commands.delete(toolCallId);
      const own = ownRuns.get(toolCallId);
      ownRuns.delete(toolCallId);
      if (own?.exitCode !== undefined && update.rawOutput == null) {
        return [
          {
            ...notification,
            update: {
              ...titledUpdate,
              rawOutput: { output: own.output.slice(-MAX_OUTPUT_CHARS), exitCode: own.exitCode },
            },
          },
        ];
      }
      if (ran === undefined || update.rawOutput != null) return [titled];
      const terminal = Array.from(terminals).find(([, run]) => run.command === ran && run.exited);
      if (terminal === undefined) return [titled];
      terminals.delete(terminal[0]);
      const { output, exitCode } = terminal[1];
      return [
        {
          ...notification,
          update: {
            ...titledUpdate,
            rawOutput: {
              output: output.slice(-MAX_OUTPUT_CHARS),
              ...(typeof exitCode === "number" ? { exitCode } : {}),
            },
          },
        },
      ];
    },
  };
}

export function withDevinToolRows(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const rows = makeDevinToolRows();
  const terminalSessions = new Map<string, string>();
  let killTerminal: Parameters<typeof runtime.handleTerminalKill>[0] | undefined;
  return {
    ...runtime,
    handleCreateTerminal: (handler) =>
      runtime.handleCreateTerminal((request, context) =>
        handler(request, context).pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              remember(terminalSessions, response.terminalId, request.sessionId);
              rows.terminalCreated(
                response.terminalId,
                [request.command, ...(request.args ?? [])].join(" "),
              );
            }),
          ),
        ),
      ),
    handleTerminalKill: (handler) => {
      killTerminal = handler;
      return runtime.handleTerminalKill(handler);
    },
    // Devin answers session/cancel by failing the command's call and never ends its terminal.
    cancel: Effect.suspend(() => {
      const abandoned = rows.runningCommandTerminals();
      return runtime.cancel.pipe(
        Effect.ensuring(
          Effect.forEach(
            abandoned,
            (terminalId) => {
              const sessionId = terminalSessions.get(terminalId);
              return killTerminal === undefined || sessionId === undefined
                ? Effect.void
                : killTerminal(
                    { sessionId, terminalId },
                    { requestId: `t3:stop:${terminalId}`, method: "terminal/kill" },
                  ).pipe(Effect.ignore);
            },
            { discard: true },
          ),
        ),
      );
    }),
    handleTerminalOutput: (handler) =>
      runtime.handleTerminalOutput((request, context) =>
        handler(request, context).pipe(
          Effect.tap((response) =>
            Effect.sync(() => rows.terminalOutput(request.terminalId, response)),
          ),
        ),
      ),
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) =>
        Effect.forEach(rows.project(notification), (projected) => handler(projected), {
          discard: true,
        }),
      ),
  };
}
