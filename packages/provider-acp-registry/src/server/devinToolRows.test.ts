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

  // Devin 3000.15 runs a command itself: the output so far as text, then `terminal_exit`.
  it("gives a command the exit code Devin reports when it runs the command itself", () => {
    const rows = makeDevinToolRows();
    const update = (fields: Partial<AcpSchema.ToolCallUpdate>) =>
      notify({ sessionUpdate: "tool_call_update", toolCallId: "call_be27", ...fields });
    const preview = update({
      status: "in_progress",
      content: text("ls: /nonexistent-zz: No such file or directory"),
      _meta: { ...exec, "cognition.ai/terminalPreview": true },
    });
    const exited = update({
      status: "in_progress",
      content: text("ls: /nonexistent-zz: No such file or directory"),
      _meta: { ...exec, terminal_exit: { terminal_id: "f75660", exit_code: 1, signal: null } },
    });
    const completed = update({ status: "completed", _meta: exec });
    rows.project(command);
    expect(rows.project(preview)).toEqual([titled(preview, "Listing /nonexistent-zz")]);
    expect(rows.project(exited)).toEqual([titled(exited, "Listing /nonexistent-zz")]);
    expect(rows.project(completed)).toEqual([
      {
        ...completed,
        update: {
          ...completed.update,
          title: "Listing /nonexistent-zz",
          rawOutput: { output: "ls: /nonexistent-zz: No such file or directory", exitCode: 1 },
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

  it("names the terminal of a command that is still running, and no other", () => {
    const rows = makeDevinToolRows();
    rows.project(command);
    rows.terminalCreated("t3-term-2", "ls /nonexistent-zz");
    rows.terminalCreated("t3-term-3", "npm run dev");
    expect(rows.runningCommandTerminals()).toEqual(["t3-term-2"]);
    rows.project(commandCompleted);
    expect(rows.runningCommandTerminals()).toEqual([]);
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
