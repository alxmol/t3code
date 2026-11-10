import {
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect, it } from "@effect/vitest";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

import {
  droidPermissionDisposition,
  droidPromptFailure,
  droidSpecMarkdown,
  extractDroidSubagentUpdate,
  isDroidAgent,
  normalizeDroidToolCall,
} from "./droidAcp.ts";

// Folds one tool call's updates the way the adapter does: merge, then normalize.
function project(...updates: ReadonlyArray<AcpSchema.SessionUpdate>): AcpToolCallState {
  let state: AcpToolCallState | undefined;
  for (const update of updates) {
    for (const event of parseSessionUpdateEvent({ sessionId: "droid-session", update }).events) {
      if (event._tag !== "ToolCallUpdated") continue;
      state = normalizeDroidToolCall(mergeToolCallState(state, event.toolCall));
    }
  }
  if (state === undefined) throw new Error("No tool call was parsed.");
  return state;
}

const text = (value: string) => [
  { type: "content" as const, content: { type: "text" as const, text: value } },
];

const policy = (interactionMode: "default" | "plan") =>
  ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode,
    cwd: "/repo",
  });

// Payloads below are Factory Droid 1.7.0 over ACP, trimmed.
const specRequest: AcpSchema.RequestPermissionRequest = {
  sessionId: "droid-session",
  options: [
    { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
    {
      optionId: "proceed_auto_run_low",
      name: "Allow & auto-run (low risk)",
      kind: "allow_always",
    },
    { optionId: "cancel", name: "No, keep iterating on spec", kind: "reject_once" },
  ],
  toolCall: {
    toolCallId: "toolu_spec",
    title: "Approve Spec",
    kind: "switch_mode",
    rawInput: { plan: "1. Create spec-ok.txt.\n2. Verify it.", title: "Create spec-ok.txt" },
  },
};
const editRequest: AcpSchema.RequestPermissionRequest = {
  sessionId: "droid-session",
  options: specRequest.options,
  toolCall: {
    toolCallId: "toolu_edit",
    title: "Create spec-ok.txt",
    kind: "edit",
    locations: [{ path: "/repo/spec-ok.txt" }],
    rawInput: { file_path: "/repo/spec-ok.txt", content: "SPEC-OK\n" },
  },
};

describe("Droid spec approval", () => {
  it("reads the spec from the ExitSpecMode request and never approves it unseen", () => {
    expect(droidSpecMarkdown(specRequest)).toBe(
      "# Create spec-ok.txt\n\n1. Create spec-ok.txt.\n2. Verify it.",
    );
    expect(droidPermissionDisposition(policy("default"), specRequest)).toBe("ask");
    expect(droidPermissionDisposition(policy("plan"), specRequest)).toBe("deny");
  });

  it("leaves every other request to the runtime policy", () => {
    expect(droidSpecMarkdown(editRequest)).toBeUndefined();
    expect(droidPermissionDisposition(policy("default"), editRequest)).toBe("allow");
  });
});

describe("Droid sub-agents", () => {
  const start: AcpSchema.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "toolu_task",
    title: "Worker: Read NOTES.md marker",
    kind: "other",
    name: "Task",
    status: "pending",
    rawInput: {
      subagent_type: "worker",
      description: "Read NOTES.md marker",
      prompt: "Read NOTES.md and reply with the marker.",
    },
  };
  const background: AcpSchema.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_task",
    name: "Task",
    status: "in_progress",
    rawOutput: { text: "Running in background" },
    content: text("Running in background"),
  };

  it("keeps a background Task running until Droid reports its result", () => {
    expect(extractDroidSubagentUpdate(project(start, background))).toEqual({
      nativeTaskId: "toolu_task",
      childSessionId: null,
      prompt: "Read NOTES.md and reply with the marker.",
      title: "Read NOTES.md marker",
      model: null,
      status: "running",
      result: null,
    });
    expect(
      extractDroidSubagentUpdate(
        project(start, background, {
          sessionUpdate: "tool_call_update",
          toolCallId: "toolu_task",
          name: "Task",
          status: "completed",
          rawOutput: { text: "FALCON-58" },
          content: text("FALCON-58"),
        }),
      ),
    ).toMatchObject({ status: "completed", result: "FALCON-58" });
  });

  it("ignores every other tool", () => {
    expect(
      extractDroidSubagentUpdate(
        project({
          sessionUpdate: "tool_call",
          toolCallId: "toolu_read",
          title: "Read NOTES.md",
          kind: "read",
          name: "Read",
          status: "pending",
          rawInput: { file_path: "/repo/NOTES.md" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("Droid tool rows", () => {
  const completed = (
    toolCallId: string,
    name: string,
    output: string,
  ): AcpSchema.SessionUpdate => ({
    sessionUpdate: "tool_call_update",
    toolCallId,
    name,
    status: "completed",
    rawOutput: { text: output },
    content: text(output),
  });

  it("titles a finished Glob, LS and ToolSearch instead of leaving them as Tool", () => {
    expect(
      project(
        {
          sessionUpdate: "tool_call",
          toolCallId: "toolu_glob",
          title: "Find *.md in .",
          kind: "search",
          locations: [{ path: "/repo/t3-proj" }],
          name: "Glob",
          status: "pending",
          rawInput: { patterns: "*.md", folder: "/repo/t3-proj" },
        },
        completed("toolu_glob", "Glob", "./NOTES.md"),
      ),
    ).toMatchObject({ kind: "search", title: "Searched files *.md in t3-proj" });
    expect(
      project(
        {
          sessionUpdate: "tool_call",
          toolCallId: "toolu_ls",
          title: "List .",
          kind: "read",
          locations: [{ path: "/repo/t3-proj" }],
          name: "LS",
          status: "pending",
          rawInput: { directory_path: "/repo/t3-proj" },
        },
        completed("toolu_ls", "LS", "total 16"),
      ),
    ).toMatchObject({ kind: "search", title: "Listed t3-proj" });
    expect(
      project(
        {
          sessionUpdate: "tool_call",
          toolCallId: "toolu_toolsearch",
          title: "Search tools: WebSearch",
          kind: "search",
          name: "ToolSearch",
          status: "pending",
          rawInput: { query: "select:WebSearch" },
        },
        completed("toolu_toolsearch", "ToolSearch", "Loaded 1 tool(s): WebSearch"),
      ),
    ).toMatchObject({ kind: "other", title: "Search tools: WebSearch" });
  });

  it("reads a command's exit code out of Droid's output text", () => {
    const failed = project(
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_exec",
        title: "ls /definitely-missing-dir",
        kind: "execute",
        name: "Execute",
        status: "pending",
        rawInput: { command: "ls /definitely-missing-dir", riskLevel: "low" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_exec",
        name: "Execute",
        status: "failed",
        rawOutput:
          "Error: Command failed (exit code: 1)\nls: /definitely-missing-dir: No such file or directory\n\n\n[Process exited with code 1]",
      },
    );
    expect(failed.title).toBeUndefined();
    expect(failed.command).toBe("ls /definitely-missing-dir");
    expect(failed.data.rawOutput).toEqual({
      output:
        "Error: Command failed (exit code: 1)\nls: /definitely-missing-dir: No such file or directory",
      exitCode: 1,
    });
  });

  it("identifies MCP calls from Droid's factory metadata", () => {
    const call = (toolCallId: string, server: string, tool: string): AcpSchema.SessionUpdate => ({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `${server}: ${tool}`,
      kind: "other",
      name: `${server}___${tool}`,
      status: "pending",
      rawInput: { libraryName: "vitest" },
      _meta: { factory: { source: "mcp", server, tool } },
    });
    expect(
      extractMcpToolCallIdentity(
        project(
          call("toolu_mcp", "context7", "resolve-library-id"),
          completed("toolu_mcp", "context7___resolve-library-id", "Available Libraries"),
        ),
      ),
    ).toEqual({ server: "context7", tool: "resolve-library-id" });
    expect(
      extractMcpToolCallIdentity(project(call("toolu_t3", "t3-code", "t3_thread_read"))),
    ).toEqual({ server: "t3-code", tool: "t3_thread_read" });
  });
});

describe("Droid prompt failures", () => {
  it("reports a rate-limited model as a usage limit with the upstream message", () => {
    const failure = droidPromptFailure(
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage:
          'Internal error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"The Claude subscription\'s 5-hour usage limit is reached. It resets Tue, 3:00 PM EST."}}',
        data: { sessionId: "droid-session", reason: "model_rate_limited" },
        method: "session/prompt",
      }),
    );
    expect(failure.class).toBe("usage_limit");
    expect(failure.message).toBe(
      "The Claude subscription's 5-hour usage limit is reached. It resets Tue, 3:00 PM EST.",
    );
  });

  it("keeps other errors as provider errors with Droid's own text", () => {
    const failure = droidPromptFailure(
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error: model not found",
        method: "session/prompt",
      }),
    );
    expect(failure).toMatchObject({
      class: "provider_error",
      message: "Internal error: model not found",
    });
  });
});

describe("isDroidAgent", () => {
  it("recognizes the registry agent and a local droid binary", () => {
    expect(isDroidAgent({ source: "registry", agentId: "factory-droid", commandPath: "" })).toBe(
      true,
    );
    expect(
      isDroidAgent({ source: "local", agentId: "", commandPath: "/Users/me/.local/bin/droid" }),
    ).toBe(true);
    expect(isDroidAgent({ source: "registry", agentId: "claude-acp", commandPath: "" })).toBe(
      false,
    );
    expect(
      isDroidAgent({ source: "local", agentId: "factory-droid", commandPath: "/bin/kiro" }),
    ).toBe(false);
  });
});
