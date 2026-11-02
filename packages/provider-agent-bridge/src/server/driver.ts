import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { AgentBridgeSettings } from "../settings.ts";
import { AGENT_BRIDGE_DRIVER_KIND, makeAgentBridgeAdapterV2 } from "./adapter.ts";
import * as AgentBridgeHub from "./AgentBridgeHub.ts";
import { agentBridgeSnapshot } from "./status.ts";

const decodeSettings = Schema.decodeSync(AgentBridgeSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: AGENT_BRIDGE_DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "The agent bridge does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type AgentBridgeDriverEnv =
  | AgentBridgeHub.AgentBridgeHub
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost;

export const AgentBridgeDriver: ProviderDriver<AgentBridgeSettings, AgentBridgeDriverEnv> = {
  driverKind: AGENT_BRIDGE_DRIVER_KIND,
  metadata: {
    displayName: "Agent bridge",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: AgentBridgeSettings,
  defaultConfig: (): AgentBridgeSettings => decodeSettings({}),
  create: Effect.fn("AgentBridgeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
    config,
  }) {
    const hub = yield* AgentBridgeHub.AgentBridgeHub;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: AGENT_BRIDGE_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: AGENT_BRIDGE_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies AgentBridgeSettings;
    const agentName = displayName ?? "Agent";
    const check = hub.lastSeenAt(instanceId).pipe(
      Effect.flatMap((lastSeenAt) =>
        agentBridgeSnapshot({ settings: effectiveConfig, agentName, lastSeenAt }),
      ),
      Effect.map(stampIdentity),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<AgentBridgeSettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: () => check,
      checkProvider: check,
      refreshOnInterval: false,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: AGENT_BRIDGE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the agent bridge provider snapshot.",
            cause,
          }),
      ),
    );
    yield* hub
      .awaitSeen(instanceId)
      .pipe(Effect.andThen(snapshot.refresh), Effect.forever, Effect.forkScoped);

    return {
      instanceId,
      driverKind: AGENT_BRIDGE_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter: yield* makeAgentBridgeAdapterV2({ instanceId }),
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
