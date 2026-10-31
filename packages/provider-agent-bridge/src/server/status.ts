import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildServerProvider,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { AgentBridgeSettings } from "../settings.ts";

const AGENT_BRIDGE_DEFAULT_MODEL_SLUG = "default";

const PRESENTATION = {
  displayName: "Agent bridge",
  showInteractionModeToggle: false,
  // The agent runs on its own host; T3 cannot enforce a narrower mode there.
  supportedRuntimeModes: ["full-access"],
} as const;

export const agentBridgeSnapshot = Effect.fn("agentBridgeSnapshot")(function* (input: {
  readonly settings: AgentBridgeSettings;
  readonly agentName: string;
  readonly lastSeenAt: DateTime.Utc | undefined;
}): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return {
    ...buildServerProvider({
      presentation: PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt,
      models: [
        {
          slug: AGENT_BRIDGE_DEFAULT_MODEL_SLUG,
          name: input.agentName,
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      probe: {
        installed: true,
        version: null,
        auth: { status: "unknown" },
        ...(input.lastSeenAt === undefined
          ? {
              status: "warning",
              message: `Waiting for ${input.agentName} to connect. Messages wait until it checks in.`,
            }
          : {
              status: "ready",
              message: `${input.agentName} has checked in since T3 Everything started.`,
            }),
      },
    }),
    supportsTextGeneration: false,
  };
});
