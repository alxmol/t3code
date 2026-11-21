import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { usageLimitContinuation } from "@t3tools/shared/usageLimits";

import { useNowMinuteMs } from "../../lib/clock";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { selectThreadModel } from "../../state/thread-model-selection";
import { useComposerDraftSettings } from "../../state/use-composer-drafts";

/** Another account that can take over a usage-limited thread; picking it only changes the selection. */
export function useUsageLimitContinuation(input: {
  readonly thread: EnvironmentThreadShell;
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly canSwitchProvider: boolean;
}) {
  const { thread, environmentId } = input;
  const now = useNowMinuteMs();
  const selection =
    useComposerDraftSettings(scopedThreadKey(environmentId, thread.id)).modelSelection ??
    thread.modelSelection;
  const limitedInstanceId = thread.runtime?.providerInstanceId;
  // Offered only while the composer still points at the limited account; picking another ends it.
  if (
    !input.canSwitchProvider ||
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !limitedInstanceId ||
    selection.instanceId !== limitedInstanceId
  ) {
    return null;
  }
  const continuation = usageLimitContinuation({
    providers: input.providers,
    instanceId: limitedInstanceId,
    model: thread.modelSelection.model,
    now,
  });
  return (
    continuation && {
      name: continuation.provider.displayName ?? continuation.provider.instanceId,
      remainingPercent: continuation.remainingPercent,
      onContinue: () =>
        selectThreadModel(
          { environmentId, threadId: thread.id },
          { instanceId: continuation.provider.instanceId, model: continuation.model },
        ),
    }
  );
}
