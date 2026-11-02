import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { buildHandOffPrompt, type HandOffTarget, resolveHandOff } from "./companyHub.logic";
import { useStartWorkThread } from "./useStartWorkThread";

interface HandOffThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly instanceId: string;
}

export function readHandOff(thread: Pick<HandOffThread, "environmentId" | "instanceId">) {
  const providers =
    appAtomRegistry
      .get(environmentPresentations.providersByEnvironmentAtom)
      .get(thread.environmentId) ?? [];
  return resolveHandOff(providers, thread.instanceId);
}

/** Opens a draft for the coding agent that links the hosted agent's thread for it to read. */
export function useHandOffThread() {
  const startWorkThread = useStartWorkThread();
  return (thread: HandOffThread, provider: HandOffTarget["provider"]) => {
    const reference = threadChipCopyTarget(
      scopeThreadRef(thread.environmentId, thread.id),
      thread.title,
    ).value;
    const agentName = readHandOff(thread)?.agentName ?? "The agent";
    return startWorkThread(
      { environmentId: thread.environmentId, id: thread.projectId },
      buildHandOffPrompt(reference, agentName),
      { kind: "coding", provider },
    );
  };
}
