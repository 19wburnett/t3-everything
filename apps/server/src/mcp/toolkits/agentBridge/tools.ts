import {
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as AgentBridgeService from "../../../agentBridge/AgentBridgeService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentBridgeService.AgentBridgeService,
  ],
};
const agent = TrimmedNonEmptyString.annotate({ description: "Your agent id, e.g. museBot." });

const BridgeInboxTool = Tool.make("t3_bridge_inbox", {
  ...shared,
  description: "Collect new user messages for your agent. Each message is returned once.",
  parameters: Schema.Struct({ agent }),
  success: Schema.Struct({
    instructions: Schema.String,
    tasks: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        threadTitle: Schema.NullOr(Schema.String),
        projectId: Schema.NullOr(ProjectId),
        project: Schema.NullOr(Schema.String),
        messages: Schema.Array(
          Schema.Struct({
            text: Schema.String,
            createdAt: Schema.String,
            attachments: Schema.Array(Schema.String),
          }),
        ),
        brain: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            contents: Schema.String,
            truncated: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

const BridgeReplyTool = Tool.make("t3_bridge_reply", {
  ...shared,
  description:
    "Post a message to a task's thread. `done: true` finishes the task unless the user sent more (then `completed` is false; read t3_bridge_inbox).",
  parameters: Schema.Struct({
    agent,
    threadId: ThreadId,
    text: Schema.String,
    done: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ completed: Schema.Boolean, unreadMessages: Schema.Number }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

export const AgentBridgeToolkit = Toolkit.make(BridgeInboxTool, BridgeReplyTool);
