import { type EnvironmentId, type ProjectId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createCompanyChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const accounts = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-channels:accounts",
    tag: WS_METHODS.companyChannelsListAccounts,
    staleTimeMs: 10_000,
  });
  // Every listing asks the mail server, so a list stays fresh briefly.
  const inbox = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-channels:inbox",
    tag: WS_METHODS.companyChannelsListInbox,
    staleTimeMs: 30_000,
  });
  const message = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-channels:message",
    tag: WS_METHODS.companyChannelsReadMessage,
    staleTimeMs: 300_000,
  });
  const outbox = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-channels:outbox",
    tag: WS_METHODS.companyChannelsListOutbox,
    staleTimeMs: 5_000,
  });

  type Target = { readonly environmentId: EnvironmentId; readonly input: { projectId: ProjectId } };
  const refreshAccounts = ({ environmentId, input }: Target, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() =>
      registry.refresh(accounts({ environmentId, input: { projectId: input.projectId } })),
    );
  const refreshOutbox = ({ environmentId, input }: Target, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() =>
      registry.refresh(outbox({ environmentId, input: { projectId: input.projectId } })),
    );

  return {
    accounts,
    inbox,
    message,
    outbox,
    saveAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:save-account",
      tag: WS_METHODS.companyChannelsSaveAccount,
      onSuccess: refreshAccounts,
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:remove-account",
      tag: WS_METHODS.companyChannelsRemoveAccount,
      onSuccess: refreshAccounts,
    }),
    startMicrosoftSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:microsoft-sign-in-start",
      tag: WS_METHODS.companyChannelsMicrosoftSignInStart,
    }),
    // Waits on the user for minutes; the account appears once it resolves.
    waitForMicrosoftSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:microsoft-sign-in-wait",
      tag: WS_METHODS.companyChannelsMicrosoftSignInWait,
      onSuccess: refreshAccounts,
    }),
    cancelMicrosoftSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:microsoft-sign-in-cancel",
      tag: WS_METHODS.companyChannelsMicrosoftSignInCancel,
    }),
    saveDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:save-draft",
      tag: WS_METHODS.companyChannelsSaveDraft,
      onSuccess: refreshOutbox,
    }),
    discardDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:discard-draft",
      tag: WS_METHODS.companyChannelsDiscardDraft,
      onSuccess: refreshOutbox,
    }),
    // One send per draft at a time; the server refuses a second one too.
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-channels:send",
      tag: WS_METHODS.companyChannelsSend,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.draftId]),
      },
      onSuccess: (target, registry) =>
        refreshOutbox(target, registry).pipe(Effect.andThen(refreshAccounts(target, registry))),
    }),
  };
}
