/**
 * Agent bridge instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-agent-bridge/settings
 */
import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AgentBridgeSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type AgentBridgeSettings = typeof AgentBridgeSettings.Type;
