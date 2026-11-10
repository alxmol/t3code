import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  AcpAdapterV2Flavor,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

const isDroidForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.Array(Schema.String),
  }),
);
const isDroidQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    oneOf: Schema.Array(
      Schema.Struct({
        const: Schema.String.check(Schema.isPattern(/^(?:option_\d+|other)$/)),
        title: TrimmedNonEmptyString,
      }),
    ),
  }),
);
const isDroidCompanion = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));

// Droid pairs each choice with an optional *_other field. The client already
// offers custom answers, so hide the companion and restore it in the response.
export const extractDroidElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isDroidForm(request.requestedSchema)) return undefined;
  const { properties, required } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^question_[1-9]\d*$/.test(id)) continue;
    if (!isDroidQuestion(field) || !isDroidCompanion(properties[`${id}_other`])) return undefined;
    const options = field.oneOf
      .filter((option) => option.const !== "other")
      .map((option) => ({ label: option.title, description: option.title, value: option.const }));
    if (options.length === 0 || !field.oneOf.some((option) => option.const === "other")) {
      return undefined;
    }
    questions.push({ id, header: field.title, question: field.description, options });
  }
  // Recognize only complete forms; leave every other schema to the ACP fallback.
  const requiredIds = new Set(required);
  if (
    questions.length === 0 ||
    Object.keys(properties).length !== questions.length * 2 ||
    requiredIds.size !== questions.length ||
    questions.some((question) => !requiredIds.has(question.id))
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!Predicate.isString(answer) || answer.trim().length === 0) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer)) {
          entries.push([question.id, answer]);
        } else {
          // Intake appends server attachment references to the selected choice ID.
          const attachmentStart = answer.indexOf("\n\n");
          const selectedOption = question.options.find(
            (option) =>
              option.value === answer.slice(0, attachmentStart) &&
              /^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/.test(
                answer.slice(attachmentStart),
              ),
          );
          const text = selectedOption
            ? `${selectedOption.label}${answer.slice(attachmentStart)}`
            : answer;
          entries.push([question.id, "other"], [`${question.id}_other`, text]);
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Local installs launch the `droid` binary directly with no registry id. */
export function isDroidAgent(settings: {
  readonly source: string;
  readonly agentId: string;
  readonly commandPath: string;
}): boolean {
  return settings.source === "local"
    ? /^droid(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
    : settings.agentId === "factory-droid";
}

export const isDroidPlanModeId = (modeId: string) => modeId === "spec";

// Droid 1.7 leaves Spec mode through an ExitSpecMode permission request that carries the spec.
export const droidSpecMarkdown: NonNullable<
  AcpAdapterV2Flavor["proposedPlanFromPermissionRequest"]
> = (request) => {
  const input = record(request.toolCall.rawInput);
  if (request.toolCall.kind !== "switch_mode" || typeof input?.plan !== "string") return undefined;
  const plan = input.plan.trim();
  if (plan.length === 0) return undefined;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  return title.length > 0 && !plan.startsWith("#") ? `# ${title}\n\n${plan}` : plan;
};

// A spec is the user's to approve. Plan mode keeps it as a plan to implement in a later turn.
export const droidPermissionDisposition: NonNullable<
  AcpAdapterV2Flavor["permissionDisposition"]
> = (policy, request) =>
  droidSpecMarkdown(request) === undefined
    ? acpPermissionDisposition(policy, request)
    : policy.interactionMode === "plan"
      ? "deny"
      : "ask";

const decodeTaskInput = Schema.decodeUnknownOption(
  Schema.Struct({ prompt: Schema.String, description: Schema.optionalKey(Schema.String) }),
);

// Droid reports a Task's child session id but sends none of that session's updates.
export function extractDroidSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "Task") return undefined;
  const input = decodeTaskInput(tool.data.rawInput);
  if (Option.isNone(input)) return undefined;
  const status =
    tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "running";
  const output = record(tool.data.rawOutput)?.text;
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input.value.prompt,
    title: input.value.description ?? null,
    model: null,
    status,
    result: status !== "running" && typeof output === "string" ? output : null,
  };
}

const DROID_EXIT_CODE = /\n*\[Process exited with code (-?\d+)\]\s*$/;

function directoryName(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.split(/[\\/]/u).findLast((part) => part.length > 0 && part !== ".")
    : undefined;
}

/**
 * Droid titles a call once, and its later updates carry only output, which the shared
 * summary reduces to "Tool". Its tool names and MCP origin are in `name` and `_meta.factory`.
 */
export function normalizeDroidToolCall(tool: AcpToolCallState): AcpToolCallState {
  const data = tool.data;
  const meta = record(data.meta);
  const factory = record(meta?.factory);
  if (
    factory?.source === "mcp" &&
    typeof factory.server === "string" &&
    typeof factory.tool === "string"
  ) {
    return meta?.serverId === factory.server && meta.toolName === factory.tool
      ? tool
      : {
          ...tool,
          data: { ...data, meta: { ...meta, serverId: factory.server, toolName: factory.tool } },
        };
  }
  const input = record(data.rawInput);
  const droidTitle = typeof data.title === "string" ? data.title : undefined;
  const title = tool.title === undefined || tool.title === "Tool" ? droidTitle : tool.title;
  switch (data.name) {
    case "Execute": {
      const { title: _summary, ...command } = tool;
      const exit = typeof data.rawOutput === "string" ? DROID_EXIT_CODE.exec(data.rawOutput) : null;
      return exit === null
        ? command
        : {
            ...command,
            data: {
              ...data,
              rawOutput: {
                output: (data.rawOutput as string).slice(0, exit.index),
                exitCode: Number(exit[1]),
              },
            },
          };
    }
    case "Glob": {
      const patterns = Array.isArray(input?.patterns) ? input.patterns.join(", ") : input?.patterns;
      const folder = directoryName(input?.folder);
      return typeof patterns === "string" && patterns.length > 0
        ? {
            ...tool,
            title: `Searched files ${patterns}${folder === undefined ? "" : ` in ${folder}`}`,
          }
        : { ...tool, ...(title === undefined ? {} : { title }) };
    }
    case "LS":
      return {
        ...tool,
        kind: "search",
        title: `Listed ${directoryName(input?.directory_path) ?? "directory"}`,
      };
    case "ToolSearch":
      return { ...tool, kind: "other", ...(title === undefined ? {} : { title }) };
    default:
      return title === undefined || title === tool.title ? tool : { ...tool, title };
  }
}

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const decodeUpstreamError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

// Droid 1.7 gives up on a rate-limited model with -32603 and the upstream reply inside its message.
export function droidPromptFailure(cause: unknown) {
  if (!isAcpRequestError(cause)) return makeProviderFailure({ cause, class: "provider_error" });
  const body = cause.errorMessage.indexOf("{");
  const upstream = body < 0 ? Option.none() : decodeUpstreamError(cause.errorMessage.slice(body));
  return makeProviderFailure({
    cause,
    message: Option.isSome(upstream) ? upstream.value.error.message : cause.errorMessage,
    code: String(cause.code),
    class: record(cause.data)?.reason === "model_rate_limited" ? "usage_limit" : "provider_error",
  });
}
