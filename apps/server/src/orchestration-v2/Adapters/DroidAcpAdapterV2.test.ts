import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { makeAcpRegistryAdapterV2 } from "@t3tools/provider-acp-registry/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DocumentText from "../../provider/DocumentText.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";

const DROID_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({ agentId: "factory-droid" });
const DRIVER = ProviderDriverKind.make("acpRegistry");

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const any = "<any>";
const expectRequest = (method: string, params: unknown = any) => ({
  type: "expect_outbound" as const,
  frame: { kind: "request", method, params },
});
const respond = (method: string, result: unknown) => ({
  type: "emit_inbound" as const,
  frame: { kind: "response", method, result },
});
const update = (sessionUpdate: Record<string, unknown>) => ({
  type: "emit_inbound" as const,
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId: "droid-session", update: sessionUpdate },
  },
});

// Factory Droid 1.7.0, trimmed: its modes, and the request that leaves Spec mode.
const DROID_MODES = {
  availableModes: [
    { id: "normal", name: "Auto (Off)" },
    { id: "spec", name: "Spec" },
    { id: "auto-high", name: "Auto (High)" },
  ],
  currentModeId: "auto-high",
};
const autonomyLevel = (currentValue: string) => ({
  configOptions: [
    {
      id: "autonomy_level",
      name: "Autonomy Level",
      category: "mode",
      type: "select",
      currentValue,
      options: DROID_MODES.availableModes.map(({ id, name }) => ({ value: id, name })),
    },
  ],
});
const SET_SPEC = [
  expectRequest("session/set_config_option", {
    sessionId: "droid-session",
    configId: "autonomy_level",
    value: "spec",
  }),
  respond("session/set_config_option", autonomyLevel("spec")),
];
const SPEC_INPUT = { plan: "1. Create spec-ok.txt.\n2. Verify it.", title: "Create spec-ok.txt" };
const SPEC_TOOL = {
  toolCallId: "toolu_spec",
  title: "Approve Spec",
  kind: "switch_mode",
  name: "ExitSpecMode",
  rawInput: SPEC_INPUT,
};
const SPEC_PERMISSION = {
  type: "emit_inbound" as const,
  frame: {
    kind: "request",
    method: "session/request_permission",
    params: {
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
      toolCall: SPEC_TOOL,
    },
  },
};
const specDecision = (optionId: string) => ({
  type: "expect_outbound" as const,
  frame: {
    kind: "response",
    method: "session/request_permission",
    result: { outcome: { outcome: "selected", optionId } },
  },
});

const openDroidTurn = Effect.fn("DroidAcpAdapterV2Test.openDroidTurn")(function* (input: {
  readonly scenario: string;
  readonly interactionMode: "default" | "plan";
  /** The Autonomy Level saved on the thread; Droid opens on Auto (High). */
  readonly autonomyLevel?: string;
  readonly entries: ReadonlyArray<unknown>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-droid-acp-" });
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: DRIVER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: input.scenario,
      entries: [
        expectRequest("initialize"),
        respond("initialize", { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        expectRequest("session/new"),
        respond("session/new", {
          sessionId: "droid-session",
          modes: DROID_MODES,
          ...(input.autonomyLevel === undefined ? {} : autonomyLevel("auto-high")),
        }),
        ...input.entries,
        { type: "runtime_exit", status: "success" },
      ],
    } as Parameters<typeof decodeAcpReplayTranscript>[0],
    DRIVER,
  );
  const instanceId = ProviderInstanceId.make(`droid-${input.scenario}`);
  const adapter = yield* makeAcpRegistryAdapterV2({
    instanceId,
    selfInvocation: yield* resolveSelfInvocation(),
    settings: DROID_SETTINGS,
    environment: {},
    makeRuntime: makeAcpReplayRuntime({
      transcript,
      statusPath: path.join(directory, "status.json"),
      fileSystem,
      scriptPath: yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      ),
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    }),
  }).pipe(
    Effect.provide(
      Layer.mock(AcpRegistryCatalog)({ resolve: () => Effect.die("runtime is injected") }),
    ),
  );
  const threadId = ThreadId.make(`droid-${input.scenario}-thread`);
  const modelSelection = {
    instanceId,
    model: "default",
    ...(input.autonomyLevel === undefined
      ? {}
      : { options: [{ id: "autonomy_level", value: input.autonomyLevel }] }),
  };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: input.interactionMode,
    cwd: directory,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    modelSelection,
    runtimePolicy,
    providerSessionId: ProviderSessionId.make(`droid-${input.scenario}-session`),
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const startTurn = Effect.fnUntraced(function* (ordinal: number) {
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        modelSelection,
        ordinal,
        now: yield* DateTime.now,
      }),
    );
  });
  yield* startTurn(1);
  return { runtime, startTurn };
});

describe("Droid over ACP", () => {
  it.live("asks before leaving Spec mode, even with full access, and shows the spec", () =>
    Effect.gen(function* () {
      const { runtime, startTurn } = yield* openDroidTurn({
        scenario: "spec-approval",
        interactionMode: "default",
        autonomyLevel: "spec",
        entries: [
          ...SET_SPEC,
          expectRequest("session/prompt"),
          update({ sessionUpdate: "tool_call", status: "pending", ...SPEC_TOOL }),
          SPEC_PERMISSION,
          specDecision("proceed_once"),
          // An approved spec moves Droid out of Spec, to the level its option names.
          update({ sessionUpdate: "config_option_update", ...autonomyLevel("normal") }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_spec",
            name: "ExitSpecMode",
            status: "completed",
          }),
          respond("session/prompt", { stopReason: "end_turn" }),
          ...SET_SPEC,
          expectRequest("session/prompt"),
          respond("session/prompt", { stopReason: "end_turn" }),
        ],
      });
      const untilApproval = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        ),
        Stream.runCollect,
      );
      const items = untilApproval.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const plan = items.find((item) => item.type === "proposed_plan");
      assert.equal(
        plan?.type === "proposed_plan" ? plan.markdown : undefined,
        "# Create spec-ok.txt\n\n1. Create spec-ok.txt.\n2. Verify it.",
      );
      const approval = items.at(-1);
      if (approval?.type !== "approval_request") return yield* Effect.die("Expected an approval");
      yield* runtime.respondToRuntimeRequest({ requestId: approval.requestId, decision: "accept" });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(Option.getOrThrow(terminal).status, "completed");

      // The thread still selects Spec, so the next turn starts in it again.
      yield* startTurn(2);
      const next = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(Option.getOrThrow(next).status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("uses Spec mode for a plan turn and keeps the spec for a later turn", () =>
    Effect.gen(function* () {
      const { runtime } = yield* openDroidTurn({
        scenario: "spec-plan-mode",
        interactionMode: "plan",
        entries: [
          expectRequest("session/set_mode", { sessionId: "droid-session", modeId: "spec" }),
          respond("session/set_mode", {}),
          expectRequest("session/prompt"),
          SPEC_PERMISSION,
          specDecision("cancel"),
          respond("session/prompt", { stopReason: "end_turn" }),
        ],
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        ),
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a rate-limited turn as a usage limit", () =>
    Effect.gen(function* () {
      const { runtime } = yield* openDroidTurn({
        scenario: "rate-limited",
        interactionMode: "default",
        entries: [
          expectRequest("session/prompt"),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              error: {
                code: -32603,
                message:
                  'Internal error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"The Claude subscription\'s 5-hour usage limit is reached. It resets Tue, 3:00 PM EST."}}',
                data: { sessionId: "droid-session", reason: "model_rate_limited" },
              },
            },
          },
        ],
      });
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      assert.equal(
        terminal.failure?.message,
        "The Claude subscription's 5-hour usage limit is reached. It resets Tue, 3:00 PM EST.",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
