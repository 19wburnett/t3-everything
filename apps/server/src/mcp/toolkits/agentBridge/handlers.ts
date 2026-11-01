import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentBridgeService from "../../../agentBridge/AgentBridgeService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AgentBridgeToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"]) => (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code, message: error.message });

export const layer = McpToolAccess.toLayer(AgentBridgeToolkit, {
  t3_bridge_inbox: McpToolAccess.writes(({ agent }) =>
    Effect.flatMap(AgentBridgeService.AgentBridgeService, (bridge) => bridge.inbox(agent)).pipe(
      Effect.catchTags({ AgentBridgeUnknownAgentError: failure("invalid_request") }),
    ),
  ),
  t3_bridge_reply: McpToolAccess.writes(({ done, ...input }) =>
    Effect.flatMap(AgentBridgeService.AgentBridgeService, (bridge) =>
      bridge.reply({ ...input, done: done ?? false }),
    ).pipe(
      Effect.catchTags({
        AgentBridgeUnknownAgentError: failure("invalid_request"),
        AgentBridgeNoOpenTaskError: failure("task_not_found"),
        AgentBridgeTaskInterruptedError: failure("task_not_found"),
      }),
    ),
  ),
  t3_bridge_share: McpToolAccess.writes((input) =>
    Effect.flatMap(AgentBridgeService.AgentBridgeService, (bridge) =>
      bridge.share({
        agent: input.agent,
        projectId: input.projectId,
        threadId: input.threadId,
        title: input.title,
        messages: input.messages,
      }),
    ).pipe(
      Effect.catchTags({
        AgentBridgeUnknownAgentError: failure("invalid_request"),
        AgentBridgeShareError: failure("invalid_request"),
      }),
    ),
  ),
});
