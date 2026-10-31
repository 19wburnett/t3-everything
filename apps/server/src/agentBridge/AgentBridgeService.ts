import { ProviderInstanceId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { AGENT_BRIDGE_DRIVER_KIND } from "@t3tools/provider-agent-bridge/server";
import * as AgentBridgeHub from "@t3tools/provider-agent-bridge/server/AgentBridgeHub";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
    return `"${this.agent}" is not an agent bridge in T3 Code. Valid agents: ${valid}.`;
  }
}

const BRAIN_FILES = ["company/BRAIN.md", "company/CHANNELS.md"] as const;
const BRAIN_FILE_MAX_CHARS = 8_000;
const INSTRUCTIONS =
  "Do each task, then post results with t3_bridge_reply (one call per message) and set done: true when the task is finished. If you need the user's approval or input, ask in a reply and set done: true; their answer arrives as a new task.";

export interface AgentBridgeInboxTask {
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
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
  }
>()("t3/agentBridge/AgentBridgeService") {}

const make = Effect.gen(function* () {
  const hub = yield* AgentBridgeHub.AgentBridgeHub;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;

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
  });
});

export const layer = Layer.effect(AgentBridgeService, make);
