import {
  OrchestratorMcpFailure,
  ProjectId,
  RuntimeRequestId,
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

const InboxTasks = Schema.Array(
  Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.NullOr(Schema.String),
    projectId: Schema.NullOr(ProjectId),
    project: Schema.NullOr(Schema.String),
    redelivered: Schema.Boolean,
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
);

const BridgeInboxTool = Tool.make("t3_bridge_inbox", {
  ...shared,
  description: "Collect new user messages for your agent. Unanswered ones return after 10 minutes.",
  parameters: Schema.Struct({ agent }),
  success: Schema.Struct({
    instructions: Schema.optional(Schema.String),
    tasks: InboxTasks,
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

const BridgeRequestApprovalTool = Tool.make("t3_bridge_request_approval", {
  ...shared,
  description:
    "Ask the user to approve an action on an open task before you take it. Keep the task open; the decision arrives in t3_bridge_inbox as a message starting with Approved or Declined.",
  parameters: Schema.Struct({
    agent,
    threadId: ThreadId,
    action: TrimmedNonEmptyString.annotate({
      description: "What you will do, e.g. Send the follow-up email to jane@acme.com.",
    }),
    reason: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ requestId: RuntimeRequestId }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

const BridgeShareTool = Tool.make("t3_bridge_share", {
  ...shared,
  description:
    "Copy a conversation from your own app into a T4 thread so the user sees it there. It is not sent back to you as a task, but any new tasks for you come back in `tasks`, as from t3_bridge_inbox. The first time, pass projectId (from t3_project_list or a task) and title, and keep the returned threadId. After that, pass threadId and only the messages added since the last share.",
  parameters: Schema.Struct({
    agent,
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
    title: Schema.optional(Schema.String),
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "agent"]).annotate({
          description: "user for the user's messages, agent for yours.",
        }),
        text: Schema.String,
      }),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    turns: Schema.Number,
    tasks: InboxTasks,
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

export const AgentBridgeToolkit = Toolkit.make(
  BridgeInboxTool,
  BridgeReplyTool,
  BridgeRequestApprovalTool,
  BridgeShareTool,
);
