import { CommandId, MessageId } from "@t3tools/contracts";
import * as AgentBridgeHub from "@t3tools/provider-agent-bridge/server/AgentBridgeHub";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const RESUME_TEXT = "T4 restarted. This task is open again.";

/** Startup recovery cancels every open run; reopen the hosted-agent tasks it cut off. */
export const resumeDetachedTasks = Effect.fn("AgentBridgeResume.resumeDetachedTasks")(function* () {
  const found = yield* Effect.serviceOption(AgentBridgeHub.AgentBridgeHub);
  if (Option.isNone(found)) return;
  const hub = found.value;
  const threads = yield* ThreadManagement.ThreadManagementService;
  for (const task of yield* hub.detached) {
    const forget = hub.forgetDetached(task);
    const shell = yield* threads
      .getThreadShell(task.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      shell === null ||
      shell.archivedAt !== null ||
      shell.activeRunId !== null ||
      shell.modelSelection.instanceId !== task.instanceId
    ) {
      yield* forget;
      continue;
    }
    const id = `${task.threadId}:${shell.latestRunId ?? "none"}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:agent-bridge-resume:${id}`),
        threadId: task.threadId,
        messageId: MessageId.make(`${AgentBridgeHub.AGENT_BRIDGE_RESUME_MESSAGE_PREFIX}${id}`),
        text: RESUME_TEXT,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "T4 restarted and reopened this task",
          detail: RESUME_TEXT,
        },
        attachments: [],
        modelSelection: shell.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not reopen an agent bridge task", {
            threadId: task.threadId,
            cause,
          }).pipe(Effect.andThen(forget)),
        ),
      );
  }
});
