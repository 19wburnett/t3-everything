import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { COMPANY_BRAIN_TEMPLATES } from "./companyHub.logic";

export function useWriteCompanyBrain() {
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }): Promise<boolean> => {
    for (const template of COMPANY_BRAIN_TEMPLATES) {
      const result = await writeProjectFile({
        environmentId: input.environmentId,
        input: { cwd: input.workspaceRoot, ...template },
      });
      if (result._tag === "Success") continue;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not create the company brain",
          description: error instanceof Error ? error.message : undefined,
        });
      }
      return false;
    }
    return true;
  };
}
