import {
  MessageId,
  ProviderDriverKind,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as AgentBridgeHub from "./AgentBridgeHub.ts";

export const AGENT_BRIDGE_DRIVER_KIND = ProviderDriverKind.make("agentBridge");

const AgentBridgeProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "weak",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const nativeRef = (nativeId: string) => ({
  driver: AGENT_BRIDGE_DRIVER_KIND,
  nativeId,
  strength: "weak" as const,
});

interface PendingApproval {
  readonly turn: ActiveTurn;
  readonly action: string;
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
}

/** The agent reads the decision as the user's next message on the task. */
function approvalDecisionText(
  action: string,
  decision: ProviderApprovalDecision | undefined,
  feedback: string | undefined,
): string {
  const verdict = decision === "accept" ? "Approved" : "Declined";
  const note = feedback?.trim();
  return note ? `${verdict}: ${action}\n\n${note}` : `${verdict}: ${action}`;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  nextOrdinal: number;
}

const bridgeMessage = Effect.fnUntraced(function* (
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
) {
  return {
    messageId: message.messageId,
    text: message.text,
    attachmentNames: message.attachments.map((attachment) => attachment.name),
    createdAt: yield* DateTime.now,
  } satisfies AgentBridgeHub.AgentBridgeMessage;
});

export const makeAgentBridgeAdapterV2 = Effect.fn("makeAgentBridgeAdapterV2")(function* (options: {
  readonly instanceId: ProviderInstanceId;
}) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const hub = yield* AgentBridgeHub.AgentBridgeHub;
  const providerHost = yield* ProviderHost.ProviderHost;
  const driver = AGENT_BRIDGE_DRIVER_KIND;
  const protocolError = (
    detail: string,
    reason?: ProviderAdapter.ProviderAdapterProtocolError["reason"],
  ) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail,
      ...(reason === undefined ? {} : { reason }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: Effect.fn("AgentBridgeAdapter.getCapabilities")(function () {
      return Effect.succeed(AgentBridgeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("AgentBridgeAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("AgentBridgeAdapter.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? providerHost.paths.cwd,
        model: input.modelSelection.model,
        capabilities: AgentBridgeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      // Per-event helpers share the calling operation's span.
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
      });
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
      ) {
        session = { ...session, status, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });
      const postAssistantMessage = Effect.fnUntraced(function* (turn: ActiveTurn, text: string) {
        const time = yield* DateTime.now;
        const ordinal = turn.nextOrdinal++;
        const identity = `${options.instanceId}:${turn.providerTurn.id}:reply:${ordinal}`;
        const ids = { driver, nativeItemId: identity };
        const messageId = idAllocator.derive.messageFromProviderItem(ids);
        const nodeId = idAllocator.derive.nodeFromProviderItem(ids);
        const { threadId, runId, rootNodeId } = turn.input;
        yield* emit({
          type: "message.updated",
          driver,
          message: {
            id: messageId,
            threadId,
            runId,
            nodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: time,
            updatedAt: time,
          },
        });
        yield* emit({
          type: "node.updated",
          driver,
          node: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: rootNodeId,
            rootNodeId,
            kind: "assistant_message",
            status: "completed",
            countsForRun: false,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: nativeRef(identity),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: time,
            completedAt: time,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem(ids),
            nodeId,
            threadId,
            runId,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: nativeRef(identity),
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: time,
            completedAt: time,
            updatedAt: time,
            type: "assistant_message",
            messageId,
            text,
            streaming: false,
          },
        });
      });
      const approvals = new Map<RuntimeRequestId, PendingApproval>();
      const showApproval = Effect.fnUntraced(function* (entry: PendingApproval) {
        yield* emit({
          type: "runtime_request.updated",
          driver,
          threadId: entry.turn.input.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver, turnItem: entry.item });
      });
      const settleApproval = Effect.fnUntraced(function* (
        entry: PendingApproval,
        response: Pick<OrchestrationV2RuntimeRequest, "decision" | "feedback"> | undefined,
      ) {
        approvals.delete(entry.request.id);
        const time = yield* DateTime.now;
        const status = response ? "completed" : "cancelled";
        entry.request = {
          ...entry.request,
          ...response,
          status: response ? "resolved" : "cancelled",
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This approval has ended." },
        };
        entry.node = { ...entry.node, status, completedAt: time };
        entry.item = { ...entry.item, status, completedAt: time, updatedAt: time };
        yield* showApproval(entry);
      });
      const requestApproval = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        approval: { readonly action: string; readonly reason: string | undefined },
      ) {
        const ordinal = turn.nextOrdinal++;
        const nativeId = `${options.instanceId}:${turn.providerTurn.id}:approval:${ordinal}`;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({
            driver,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId: nativeId,
          })
          .pipe(Effect.orDie);
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const { threadId, runId, rootNodeId } = turn.input;
        const entry: PendingApproval = {
          turn,
          action: approval.action,
          request: {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurn.id,
            nativeRequestRef: nativeRef(nativeId),
            kind: "permission",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
              supportsFeedback: true,
            },
            createdAt: time,
            resolvedAt: null,
          },
          node: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: rootNodeId,
            rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: nativeRef(nativeId),
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: time,
            completedAt: null,
          },
          item: {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            nodeId,
            threadId,
            runId,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: nativeRef(nativeId),
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: time,
            completedAt: null,
            updatedAt: time,
            type: "approval_request",
            requestId,
            requestKind: "permission",
            prompt: approval.action,
            ...(approval.reason?.trim() ? { reason: approval.reason.trim() } : {}),
            options: [
              { decision: "decline", label: "Decline" },
              { decision: "accept", label: "Approve" },
            ],
          },
        };
        approvals.set(requestId, entry);
        yield* showApproval(entry);
        yield* updateSession("waiting");
        return requestId;
      });
      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "interrupted",
      ) {
        if (active !== turn) return;
        active = undefined;
        for (const entry of approvals.values()) {
          if (entry.turn === turn) yield* settleApproval(entry, undefined);
        }
        turn.providerTurn = { ...turn.providerTurn, status, completedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: "idle" });
        yield* updateSession("ready");
        yield* emit({
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
      });
      const attach = (providerThread: OrchestrationV2ProviderThread) => {
        thread = { ...providerThread, providerSessionId: input.providerSessionId };
        return thread;
      };
      const ownsThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined && candidate.id === thread.id;

      yield* Effect.addFinalizer(() => {
        const turn = active;
        if (!turn) return Effect.void;
        active = undefined;
        return hub.detach({
          instanceId: options.instanceId,
          threadId: turn.input.threadId,
          providerTurnId: turn.providerTurn.id,
        });
      });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (!ownsThread(turnInput.providerThread))
          return yield* protocolError("This thread is not attached to the agent bridge session");
        if (active)
          return yield* protocolError(
            "The agent already has an open task; queue through the orchestrator",
            "previous_turn_active",
          );
        const startedAt = yield* DateTime.now;
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn: {
            id: idAllocator.derive.providerTurn({
              driver,
              nativeTurnId: `${options.instanceId}:${turnInput.threadId}:${turnInput.attemptId}`,
            }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: nativeRef(turnInput.attemptId),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          },
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
        };
        active = turn;
        thread = turnInput.providerThread;
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turnInput.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: "active",
          firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* updateSession("running");
        yield* hub.open({
          instanceId: options.instanceId,
          threadId: turnInput.threadId,
          providerTurnId: turn.providerTurn.id,
          message: yield* bridgeMessage(turnInput.message),
          reply: Effect.fnUntraced(function* ({ text, done }) {
            if (active !== turn) return;
            if (text.trim()) yield* postAssistantMessage(turn, text);
            if (done) yield* finish(turn, "completed");
          }),
          requestApproval: (approval) => requestApproval(turn, approval),
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: Effect.fn("AgentBridgeAdapter.ensureThread")(function* (args) {
          if (args.existingProviderThread) return attach(args.existingProviderThread);
          if (thread && thread.appThreadId === args.threadId) return thread;
          const createdAt = yield* DateTime.now;
          const created = attach({
            id: idAllocator.derive.providerThread({
              driver,
              providerInstanceId: options.instanceId,
              nativeThreadId: args.threadId,
            }),
            driver,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: args.threadId,
            ownerNodeId: null,
            nativeThreadRef: nativeRef(args.threadId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          });
          yield* emit({ type: "provider_thread.updated", driver, providerThread: created });
          return created;
        }),
        resumeThread: Effect.fn("AgentBridgeAdapter.resumeThread")(function (args) {
          return Effect.sync(() => attach(args.providerThread));
        }),
        startTurn: (args) =>
          start(args).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: Effect.fn("AgentBridgeAdapter.steerTurn")(function* (args) {
          const steered = yield* hub.steer({
            instanceId: options.instanceId,
            threadId: args.threadId,
            providerTurnId: args.providerTurnId,
            message: yield* bridgeMessage(args.message),
          });
          if (!steered)
            return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
              driver,
              providerThreadId: args.providerThread.id,
              providerTurnId: args.providerTurnId,
              cause: "The agent's task already ended.",
            });
        }),
        interruptTurn: Effect.fn("AgentBridgeAdapter.interruptTurn")(function* (args) {
          const turn = active;
          if (!turn || turn.providerTurn.id !== args.providerTurnId) return;
          const closed = yield* hub.close({
            instanceId: options.instanceId,
            threadId: turn.input.threadId,
            providerTurnId: turn.providerTurn.id,
            interrupted: true,
          });
          if (closed) yield* finish(turn, "interrupted");
        }),
        respondToRuntimeRequest: Effect.fn("AgentBridgeAdapter.respondToRuntimeRequest")(
          function* (args) {
            const entry = approvals.get(args.requestId);
            if (!entry || active !== entry.turn)
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver,
                requestId: args.requestId,
                cause: "This approval is no longer pending.",
              });
            const decision = args.decision === "accept" ? "accept" : "decline";
            yield* settleApproval(entry, {
              decision,
              ...(args.feedback === undefined ? {} : { feedback: args.feedback }),
            });
            yield* hub.decide({
              instanceId: options.instanceId,
              threadId: entry.turn.input.threadId,
              providerTurnId: entry.turn.providerTurn.id,
              requestId: args.requestId,
              message: {
                messageId: MessageId.make(`approval:${args.requestId}`),
                text: approvalDecisionText(entry.action, decision, args.feedback),
                attachmentNames: [],
                createdAt: yield* DateTime.now,
              },
            });
            if (![...approvals.values()].some((other) => other.turn === entry.turn))
              yield* updateSession("running");
          },
        ),
        readThreadSnapshot: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver,
              providerThreadId: args.providerThread.id,
              cause: "The agent bridge keeps no conversation of its own to read.",
            }),
          ),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "The agent bridge does not support conversation rollback.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver,
              providerThreadId: args.sourceProviderThread.id,
              cause: "The agent bridge does not support native forks.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
