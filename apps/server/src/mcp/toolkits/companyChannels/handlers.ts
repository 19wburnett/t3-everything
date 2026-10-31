import {
  type CompanyChannelError,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CompanyChannels from "../../../companyChannels/CompanyChannels.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, resolveProjectId } from "../../threadAccess.ts";
import { CompanyChannelsToolkit } from "./tools.ts";

const failure = (error: CompanyChannelError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "storage" || error.reason === "unreachable"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

/** Thread agents work for their own company; outside clients name one. */
const companyProject = Effect.fn("mcp.companyProject")(function* (
  projectId: ProjectId | undefined,
) {
  const caller = yield* loadCaller();
  if (
    caller.caller !== undefined &&
    projectId !== undefined &&
    projectId !== caller.caller.projectId
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A thread can only use its own company's channels. Omit projectId.",
    });
  }
  return { caller, projectId: yield* resolveProjectId(caller, projectId) };
});

const callerLabel = Effect.fn("mcp.companyCallerLabel")(function* (
  caller: Effect.Success<ReturnType<typeof loadCaller>>,
) {
  const client = caller.scope.client;
  if (caller.scope.thread === undefined) return client?.label ?? "Agent";
  const instanceId = caller.scope.thread.providerInstanceId;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const instance = (yield* registry.listInstances).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  return instance?.displayName ?? instanceId;
});

export const layer = McpToolAccess.toLayer(CompanyChannelsToolkit, {
  t3_company_inbox: McpToolAccess.readsPrivate((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* companyProject(input.projectId);
      const channels = yield* CompanyChannels.CompanyChannels;
      const accounts = yield* channels.listAccounts(projectId);
      const accountId =
        input.accountId ?? accounts.find((account) => account.kind === "email")?.id ?? null;
      const inbox =
        accountId === null
          ? { messages: [] }
          : yield* channels.listInbox({
              projectId,
              accountId,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });
      return {
        accounts: accounts.map(({ id, kind, label, address, health }) => ({
          id,
          kind,
          label,
          address,
          health,
        })),
        accountId,
        messages: inbox.messages,
      };
    }).pipe(Effect.catchTags({ CompanyChannelError: (error) => Effect.fail(failure(error)) })),
  ),
  t3_company_message: McpToolAccess.readsPrivate((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* companyProject(input.projectId);
      const channels = yield* CompanyChannels.CompanyChannels;
      return yield* channels.readMessage({
        projectId,
        accountId: input.accountId,
        messageId: input.messageId,
      });
    }).pipe(Effect.catchTags({ CompanyChannelError: (error) => Effect.fail(failure(error)) })),
  ),
  t3_company_draft: McpToolAccess.writesWithCapability(({ projectId: requested, ...input }) =>
    Effect.gen(function* () {
      const { caller, projectId } = yield* companyProject(requested);
      const channels = yield* CompanyChannels.CompanyChannels;
      const draft = yield* channels.saveDraft({
        projectId,
        createdBy: yield* callerLabel(caller),
        draft: {
          channel: input.channel,
          accountId: input.accountId,
          text: input.text,
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.cc === undefined ? {} : { cc: input.cc }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: input.replyToMessageId }),
        },
      });
      return { id: draft.id, path: draft.path, status: draft.status };
    }).pipe(Effect.catchTags({ CompanyChannelError: (error) => Effect.fail(failure(error)) })),
  ),
});
