import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { toastManager } from "../ui/toast";
import { resolveWorkTaskModelSelection, type WorkTaskTarget } from "./companyHub.logic";

export function useStartWorkThread() {
  const handleNewThread = useNewThreadHandler();
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    prompt: string,
    target: WorkTaskTarget,
  ) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      prompt,
    }).catch(() => null);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not start a new thread" });
      return;
    }
    const providers =
      appAtomRegistry
        .get(environmentPresentations.providersByEnvironmentAtom)
        .get(project.environmentId) ?? [];
    const resolved = resolveWorkTaskModelSelection(providers, target);
    if ("warning" in resolved) {
      toastManager.add({
        type: "warning",
        title: resolved.warning,
        description: "Set it up in Settings > Providers. Your default model is used for now.",
      });
      return;
    }
    useComposerDraftStore.getState().setModelSelection(opened.draftId, resolved.selection, {
      explicit: true,
      replaceOptions: true,
    });
  };
}
