import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { AGENT_BRIDGE_DRIVER_KIND } from "@t3tools/provider-agent-bridge/server";
import * as AgentBridgeHub from "@t3tools/provider-agent-bridge/server/AgentBridgeHub";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

export class AgentBridgeUnknownAgentError extends Schema.TaggedError<AgentBridgeUnknownAgentError>()(
  "AgentBridgeUnknownAgentError",
  { agent: Schema.String, validAgents: Schema.Array(ProviderInstanceId) },
) {
  override get message(): string {
    const valid = this.validAgents.length === 0 ? "none" : this.validAgents.join(", ");
    return `"${this.agent}" is not an agent bridge in T3 Everything. Valid agents: ${valid}.`;
  }
}

export class AgentBridgeShareError extends Schema.TaggedError<AgentBridgeShareError>()(
  "AgentBridgeShareError",
  { message: Schema.String },
) {}

export interface AgentBridgeSharedMessage {
  readonly role: "user" | "agent";
  readonly text: string;
}

const SHARE_TURN_TIMEOUT_MS = 30_000;

/** Each exchange becomes one turn: the user's messages, answered by the agent's replies. */
export function toShareExchanges(
  messages: ReadonlyArray<AgentBridgeSharedMessage>,
): ReadonlyArray<{ readonly text: string; readonly replies: ReadonlyArray<string> }> {
  const exchanges: Array<{ user: Array<string>; replies: Array<string> }> = [];
  for (const message of messages) {
    const text = message.text.trim();
    // A lone slash command was the other app's command, and here it would run as T3's own (/compact).
    if (text.length === 0 || (message.role === "user" && /^\/\S+$/.test(text))) continue;
    const last = exchanges.at(-1);
    if (message.role === "agent" && last) last.replies.push(text);
    else if (message.role === "user" && last && last.replies.length === 0) last.user.push(text);
    else
      exchanges.push(
        message.role === "user" ? { user: [text], replies: [] } : { user: [], replies: [text] },
      );
  }
  return exchanges.map((exchange) => ({
    text:
      exchange.user.length === 0 ? "(Earlier in this conversation)" : exchange.user.join("\n\n"),
    replies: exchange.replies,
  }));
}

const BRAIN_FILES = ["company/BRAIN.md", "company/CHANNELS.md"] as const;
const BRAIN_FILE_MAX_CHARS = 8_000;
const INSTRUCTIONS =
  "Do each task, then post results with t3_bridge_reply (one call per message) and set done: true when the task is finished. Before anything the user should approve, such as sending, publishing, or paying, call t3_bridge_request_approval and leave the task open; the decision arrives here as a message on the same task, starting with Approved or Declined. If you need other input, ask in a reply and set done: true; their answer arrives as a new task.";

export interface AgentBridgeInboxTask {
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
  readonly projectId: ProjectId | null;
  readonly project: string | null;
  readonly messages: ReadonlyArray<{
    readonly text: string;
    readonly createdAt: string;
    readonly attachments: ReadonlyArray<string>;
  }>;
  readonly brain: ReadonlyArray<{
    readonly path: string;
    readonly contents: string;
    readonly truncated: boolean;
  }>;
}

export class AgentBridgeService extends Context.Service<
  AgentBridgeService,
  {
    /** Hands over unread messages; what it reads afterwards cannot fail the call. */
    readonly inbox: (
      agent: string,
    ) => Effect.Effect<
      { readonly instructions: string; readonly tasks: ReadonlyArray<AgentBridgeInboxTask> },
      AgentBridgeUnknownAgentError
    >;
    readonly reply: (input: {
      readonly agent: string;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly done: boolean;
    }) => Effect.Effect<
      { readonly completed: boolean; readonly unreadMessages: number },
      | AgentBridgeUnknownAgentError
      | AgentBridgeHub.AgentBridgeNoOpenTaskError
      | AgentBridgeHub.AgentBridgeTaskInterruptedError
    >;
    readonly requestApproval: (input: {
      readonly agent: string;
      readonly threadId: ThreadId;
      readonly action: string;
      readonly reason: string | undefined;
    }) => Effect.Effect<
      { readonly requestId: RuntimeRequestId },
      | AgentBridgeUnknownAgentError
      | AgentBridgeHub.AgentBridgeNoOpenTaskError
      | AgentBridgeHub.AgentBridgeTaskInterruptedError
    >;
    /** Copies a conversation held by the agent's own app into a thread, without sending it to the agent. */
    readonly share: (input: {
      readonly agent: string;
      readonly projectId: ProjectId | undefined;
      readonly threadId: ThreadId | undefined;
      readonly title: string | undefined;
      readonly messages: ReadonlyArray<AgentBridgeSharedMessage>;
    }) => Effect.Effect<
      { readonly threadId: ThreadId; readonly projectId: ProjectId; readonly turns: number },
      AgentBridgeUnknownAgentError | AgentBridgeShareError
    >;
  }
>()("t3/agentBridge/AgentBridgeService") {}

const make = Effect.gen(function* () {
  const hub = yield* AgentBridgeHub.AgentBridgeHub;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const randomUUID = (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);

  const resolveAgent = Effect.fn("AgentBridgeService.resolveAgent")(function* (agent: string) {
    const bridges = (yield* registry.listInstances).filter(
      (instance) => instance.driverKind === AGENT_BRIDGE_DRIVER_KIND,
    );
    const match = bridges.find((instance) => instance.instanceId === agent);
    if (match) return match.instanceId;
    return yield* new AgentBridgeUnknownAgentError({
      agent,
      validAgents: bridges.map((instance) => instance.instanceId),
    });
  });

  const readBrain = Effect.fn("AgentBridgeService.readBrain")(function* (workspaceRoot: string) {
    const files = yield* Effect.forEach(BRAIN_FILES, (relativePath) =>
      workspaceFiles.readFile({ cwd: workspaceRoot, relativePath, allowMissing: true }).pipe(
        Effect.map((file) =>
          file.exists === false
            ? []
            : [
                {
                  path: relativePath,
                  contents: file.contents.slice(0, BRAIN_FILE_MAX_CHARS),
                  truncated: file.truncated || file.contents.length > BRAIN_FILE_MAX_CHARS,
                },
              ],
        ),
        Effect.orElseSucceed(() => []),
      ),
    );
    return files.flat();
  });

  const readProject = Effect.fn("AgentBridgeService.readProject")(function* (projectId: ProjectId) {
    const found = yield* projects
      .getShell(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(found)) return { title: null, brain: [] };
    return { title: found.value.title, brain: yield* readBrain(found.value.workspaceRoot) };
  });

  const shareFailure = (message: string) => new AgentBridgeShareError({ message });

  const resolveShareTarget = Effect.fn("AgentBridgeService.resolveShareTarget")(function* (
    instanceId: ProviderInstanceId,
    input: { readonly projectId: ProjectId | undefined; readonly threadId: ThreadId | undefined },
  ) {
    if (input.threadId === undefined) {
      if (input.projectId === undefined) {
        return yield* shareFailure(
          "Pass projectId for a new conversation, or the threadId it returned before.",
        );
      }
      const project = yield* projects
        .getShell(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project)) return yield* shareFailure(`No project ${input.projectId}.`);
      return { projectId: input.projectId, threadId: undefined };
    }
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* shareFailure(`No thread ${input.threadId}.`);
    if (shell.modelSelection.instanceId !== instanceId) {
      return yield* shareFailure(`Thread ${input.threadId} is not a ${instanceId} thread.`);
    }
    if (shell.activeRunId !== null) {
      return yield* shareFailure(
        `Thread ${input.threadId} has an open task. Answer it with t3_bridge_reply first.`,
      );
    }
    return { projectId: shell.projectId, threadId: input.threadId };
  });

  return AgentBridgeService.of({
    inbox: Effect.fn("AgentBridgeService.inbox")(function* (agent) {
      const instanceId = yield* resolveAgent(agent);
      const taken = yield* hub.takeInbox(instanceId);
      const projectCache = new Map<ProjectId, Effect.Success<ReturnType<typeof readProject>>>();
      const tasks = yield* Effect.forEach(taken, (task) =>
        Effect.gen(function* () {
          const shell = yield* threads
            .getThreadShell(task.threadId)
            .pipe(Effect.orElseSucceed(() => null));
          let project = shell ? projectCache.get(shell.projectId) : undefined;
          if (shell && !project) {
            project = yield* readProject(shell.projectId);
            projectCache.set(shell.projectId, project);
          }
          return {
            threadId: task.threadId,
            threadTitle: shell?.title ?? null,
            projectId: shell?.projectId ?? null,
            project: project?.title ?? null,
            messages: task.messages.map((message) => ({
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
              attachments: message.attachmentNames,
            })),
            brain: project?.brain ?? [],
          } satisfies AgentBridgeInboxTask;
        }),
      );
      return { instructions: INSTRUCTIONS, tasks };
    }),
    reply: Effect.fn("AgentBridgeService.reply")(function* (input) {
      const instanceId = yield* resolveAgent(input.agent);
      return yield* hub.reply({
        instanceId,
        threadId: input.threadId,
        text: input.text,
        done: input.done,
      });
    }),
    requestApproval: Effect.fn("AgentBridgeService.requestApproval")(function* (input) {
      const instanceId = yield* resolveAgent(input.agent);
      return yield* hub.requestApproval({
        instanceId,
        threadId: input.threadId,
        action: input.action,
        reason: input.reason,
      });
    }),
    share: Effect.fn("AgentBridgeService.share")(function* (input) {
      const instanceId = yield* resolveAgent(input.agent);
      const exchanges = toShareExchanges(input.messages);
      if (exchanges.length === 0) return yield* shareFailure("No messages to share.");
      const target = yield* resolveShareTarget(instanceId, input);
      const threadId = target.threadId ?? ThreadId.make(yield* randomUUID);
      const { projectId } = target;
      for (const [index, exchange] of exchanges.entries()) {
        yield* hub.preload({ instanceId, threadId, replies: exchange.replies });
        const commandId = CommandId.make(yield* randomUUID);
        const messageId = MessageId.make(yield* randomUUID);
        const addFailure = (error: { readonly message: string }) =>
          shareFailure(`Could not add the conversation: ${error.message}`);
        const runId =
          index === 0 && target.threadId === undefined
            ? yield* threadLaunch
                .launch({
                  commandId,
                  threadId,
                  projectId,
                  title: input.title?.trim() || exchange.text.slice(0, 80),
                  modelSelection: { instanceId, model: "default" },
                  runtimeMode: "full-access",
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  workspaceStrategy: { type: "root" },
                  initialMessage: { messageId, text: exchange.text, attachments: [] },
                  createdBy: "agent",
                  creationSource: "mcp",
                })
                .pipe(
                  Effect.map((launched) => launched.projection.runs.at(-1)?.id),
                  Effect.mapError(addFailure),
                )
            : yield* threads
                .sendToThread({
                  projectId,
                  commandId,
                  threadId,
                  messageId,
                  text: exchange.text,
                  attachments: [],
                  mode: "queue",
                  createdBy: "agent",
                  creationSource: "mcp",
                })
                .pipe(
                  Effect.map((sent) => sent.run.id),
                  Effect.mapError(addFailure),
                );
        const waited = yield* threads
          .waitForThread({
            projectId,
            threadId,
            ...(runId === undefined ? {} : { runId }),
            timeoutMs: SHARE_TURN_TIMEOUT_MS,
          })
          .pipe(Effect.mapError((error) => shareFailure(error.message)));
        if (waited.timedOut || waited.run?.status !== "completed") {
          yield* hub.unpreload({ instanceId, threadId });
          return yield* shareFailure(
            `Shared ${index} of ${exchanges.length} exchanges before the thread stopped. Share the rest with this threadId.`,
          );
        }
      }
      return { threadId, projectId, turns: exchanges.length };
    }),
  });
});

export const layer = Layer.effect(AgentBridgeService, make);
