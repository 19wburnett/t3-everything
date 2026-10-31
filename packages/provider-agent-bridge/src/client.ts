/**
 * Agent bridge client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-agent-bridge/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { AgentBridgeSettings } from "./settings.ts";

export const agentBridgeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("agentBridge"),
  label: "Agent bridge",
  featured: false,
  hasDefaultInstance: false,
  settingsSchema: AgentBridgeSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [{ d: "M2 17h20v2H2zM4 16v-4a8 8 0 0 1 16 0v4h-2v-4a6 6 0 0 0-12 0v4zM11 9h2v7h-2z" }],
  },
});
