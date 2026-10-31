import {
  CompanyChannelAccountId,
  CompanyChannelHealth,
  CompanyChannelKind,
  CompanyDraftId,
  CompanyDraftStatus,
  CompanyInboxMessage,
  CompanyInboxMessageSummary,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CompanyChannels from "../../../companyChannels/CompanyChannels.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    CompanyChannels.CompanyChannels,
  ],
};
const projectId = Schema.optional(ProjectId).annotate({
  description: "The company's project. Defaults to your thread's.",
});

const CompanyInboxTool = Tool.make("t3_company_inbox", {
  ...shared,
  description:
    "List a company email inbox, newest first. Without accountId, also lists the company's channel accounts and uses the first email account.",
  parameters: Schema.Struct({
    projectId,
    accountId: Schema.optional(CompanyChannelAccountId),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        id: CompanyChannelAccountId,
        kind: CompanyChannelKind,
        label: Schema.String,
        address: Schema.String,
        health: CompanyChannelHealth,
      }),
    ),
    accountId: Schema.NullOr(CompanyChannelAccountId),
    messages: Schema.Array(CompanyInboxMessageSummary),
  }),
}).annotate(Tool.Destructive, false);

const CompanyMessageTool = Tool.make("t3_company_message", {
  ...shared,
  description: "Read one company inbox message as plain text.",
  parameters: Schema.Struct({
    projectId,
    accountId: CompanyChannelAccountId,
    messageId: TrimmedNonEmptyString,
  }),
  success: CompanyInboxMessage,
}).annotate(Tool.Destructive, false);

const CompanyDraftTool = Tool.make("t3_company_draft", {
  ...shared,
  description:
    "Draft an email or a post into the company outbox. You cannot send: the user reviews and sends it in the Company hub.",
  parameters: Schema.Struct({
    projectId,
    channel: CompanyChannelKind,
    accountId: CompanyChannelAccountId,
    text: TrimmedNonEmptyString,
    to: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    cc: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    subject: Schema.optional(Schema.String),
    replyToMessageId: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "An inbox message id to answer; fills in the recipient and subject.",
    }),
  }),
  success: Schema.Struct({
    id: CompanyDraftId,
    path: Schema.String,
    status: CompanyDraftStatus,
  }),
}).annotate(Tool.Destructive, false);

export const CompanyChannelsToolkit = Toolkit.make(
  CompanyInboxTool,
  CompanyMessageTool,
  CompanyDraftTool,
);
