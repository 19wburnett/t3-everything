import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createBrowserCredentialEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:browser-credentials:list",
    tag: WS_METHODS.browserCredentialsList,
    staleTimeMs: 5_000,
  });
  // A failed sync or unlock can still reveal a changed manager status, so refresh either way.
  const refreshList = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));
  return {
    list,
    import: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-credentials:import",
      tag: WS_METHODS.browserCredentialsImport,
      onSettled: refreshList,
    }),
    sync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-credentials:sync",
      tag: WS_METHODS.browserCredentialsSync,
      onSettled: refreshList,
    }),
    unlockBitwarden: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-credentials:unlock-bitwarden",
      tag: WS_METHODS.browserCredentialsUnlockBitwarden,
      onSettled: refreshList,
    }),
    lockBitwarden: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-credentials:lock-bitwarden",
      tag: WS_METHODS.browserCredentialsLockBitwarden,
      onSettled: refreshList,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-credentials:remove",
      tag: WS_METHODS.browserCredentialsRemove,
      onSettled: refreshList,
    }),
  };
}
