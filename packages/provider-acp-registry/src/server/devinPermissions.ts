import type * as AcpSchema from "effect-acp/compat";

import { devinAnswerablePermissionOptions } from "./devinAcp.ts";

/**
 * Devin marks four choices allow_always (this session, this project, all projects, bypass mode)
 * and T3 answers "this session" with the first of that kind. Without a this-session choice the
 * answer is allow_once, and T3's own session grant covers the rest of the session.
 */
export function devinSessionPermissionOptions(
  request: AcpSchema.RequestPermissionRequest,
): ReadonlyArray<AcpSchema.PermissionOption> {
  return devinAnswerablePermissionOptions(request).filter((option) => {
    const optionId = option.optionId.trim();
    if (/(?:^|_)bypass$/.test(optionId)) return false;
    return option.kind !== "allow_always" || optionId === "allow_session";
  });
}
