import { describe, expect, it } from "@effect/vitest";
import type * as AcpSchema from "effect-acp/compat";

import { makeDevinToolRows } from "./devinToolRows.ts";

const notify = (update: AcpSchema.SessionUpdate): AcpSchema.SessionNotification => ({
  sessionId: "educated-chatter",
  update,
});
const text = (value: string): Array<AcpSchema.ToolCallContent> => [
  { type: "content", content: { type: "text", text: value } },
];
const titled = (notification: AcpSchema.SessionNotification, title: string) => ({
  ...notification,
  update: { ...notification.update, title },
});
const exec = { "cognition.ai/inferenceToolName": "exec" };
const runSubagent = { "cognition.ai/inferenceToolName": "run_subagent" };

// Shapes recorded from Devin 3000.14 inside T3.
describe("makeDevinToolRows", () => {
  const command = notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_be27",
    title: "Listing /nonexistent-zz",
    kind: "execute",
    rawInput: { command: "ls /nonexistent-zz" },
    _meta: exec,
  });
  const commandCompleted = notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_be27",
    status: "completed",
    content: text("Exited with code 1"),
    _meta: exec,
  });

  it("gives a command the output and exit code of the terminal that ran it", () => {
    const rows = makeDevinToolRows();
    expect(rows.project(command)).toEqual([command]);
    rows.terminalCreated("t3-term-2", "ls /nonexistent-zz");
    rows.terminalOutput("t3-term-2", {
      output: "ls: /nonexistent-zz: No such file or directory\n",
      truncated: false,
      exitStatus: { exitCode: 1, signal: null },
    });
    expect(rows.project(commandCompleted)).toEqual([
      {
        ...commandCompleted,
        update: {
          ...commandCompleted.update,
          title: "Listing /nonexistent-zz",
          rawOutput: { output: "ls: /nonexistent-zz: No such file or directory\n", exitCode: 1 },
        },
      },
    ]);
  });

  it("leaves a command alone when its terminal has not exited", () => {
    const rows = makeDevinToolRows();
    rows.project(command);
    rows.terminalCreated("t3-term-2", "ls /nonexistent-zz");
    rows.terminalOutput("t3-term-2", { output: "partial", truncated: false });
    expect(rows.project(commandCompleted)).toEqual([
      titled(commandCompleted, "Listing /nonexistent-zz"),
    ]);
  });

  const task = "Read NOTES.md and reply with its marker only.";
  const call = notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_b00a",
    title: "Running explore subagent Read NOTES.md marker",
    rawInput: { profile: "subagent_explore", task, title: "Read NOTES.md marker" },
    _meta: runSubagent,
  });
  const callRunning = notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_b00a",
    status: "in_progress",
    _meta: runSubagent,
  });
  const callEnded = (status: "completed" | "failed") =>
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_b00a",
      status,
      content: text("FALCON-58"),
      _meta: runSubagent,
    });
  const started = notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "05f2399a",
    status: "in_progress",
    _meta: {
      "cognition.ai/subagent_started": { agentId: "05f2399a", title: "Read NOTES.md marker", task },
    },
  });

  it("shows a sub-agent once, as the sub-agent Devin reports", () => {
    const rows = makeDevinToolRows();
    const shown = [call, callRunning, started, callEnded("completed")].flatMap(rows.project);
    expect(shown).toEqual([started]);
  });

  it("keeps a run_subagent call that starts no sub-agent, and one that fails", () => {
    const rows = makeDevinToolRows();
    const title = "Running explore subagent Read NOTES.md marker";
    expect([call, callRunning, callEnded("completed")].flatMap(rows.project)).toEqual([
      call,
      titled(callRunning, title),
      titled(callEnded("completed"), title),
    ]);
    expect([call, started, callEnded("failed")].flatMap(rows.project)).toEqual([
      started,
      titled(callEnded("failed"), title),
    ]);
  });
});
