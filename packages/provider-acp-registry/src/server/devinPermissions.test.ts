import { describe, expect, it } from "@effect/vitest";
import type * as AcpSchema from "effect-acp/compat";

import { devinSessionPermissionOptions } from "./devinPermissions.ts";

// Recorded from Devin 3000.14 inside T3: its request before running `ls /nonexistent-zz`.
const commandRequest: AcpSchema.RequestPermissionRequest = {
  sessionId: "educated-chatter",
  toolCall: {
    toolCallId: "call_be27fb3c9dfdf34e",
    _meta: {
      "cognition.ai/editableCommand": "ls /nonexistent-zz",
      "cognition.ai/permissionRule": "Exec(ls)",
    },
  },
  options: [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    {
      optionId: "allow_session",
      name: "Yes, allow `ls` commands (this session)",
      kind: "allow_always",
    },
    {
      optionId: "allow_always",
      name: "Yes, always allow `ls` commands in `t3-proj`",
      kind: "allow_always",
    },
    {
      optionId: "allow_always_global",
      name: "Yes, always allow `ls` commands in all projects",
      kind: "allow_always",
    },
    { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ],
};
const ids = (request: AcpSchema.RequestPermissionRequest) =>
  devinSessionPermissionOptions(request).map((option) => option.optionId);

describe("Devin permission answers", () => {
  it("leaves this-session as the only lasting answer, wherever Devin lists it", () => {
    expect(ids(commandRequest)).toEqual(["allow_once", "allow_session", "reject_once"]);
    expect(ids({ ...commandRequest, options: commandRequest.options.toReversed() })).toEqual([
      "reject_once",
      "allow_session",
      "allow_once",
    ]);
  });

  it("answers once when Devin offers no this-session option", () => {
    expect(
      ids({
        ...commandRequest,
        options: commandRequest.options.filter((option) => option.optionId !== "allow_session"),
      }),
    ).toEqual(["allow_once", "reject_once"]);
  });

  it("never answers with a bypass option, whatever its kind", () => {
    expect(
      ids({
        ...commandRequest,
        options: [
          { optionId: "plan_bypass", name: "Yes, and bypass permissions", kind: "allow_once" },
          { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_once" },
          { optionId: "plan_accept_edits", name: "Yes, and accept edits", kind: "allow_once" },
        ],
      }),
    ).toEqual(["plan_accept_edits"]);
  });
});
