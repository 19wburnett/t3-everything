import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as AgentBridgeHub from "@t3tools/provider-agent-bridge/server/AgentBridgeHub";
import { makeAgentBridgeAdapterV2 } from "@t3tools/provider-agent-bridge/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("museBot");
const threadId = ThreadId.make("thread:agent-bridge");

const harness = Effect.fn("agentBridgeHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const hub = yield* AgentBridgeHub.AgentBridgeHub;
  const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    makeAgentBridgeAdapterV2({ instanceId }).pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        IdAllocator.layer,
        Layer.succeed(AgentBridgeHub.AgentBridgeHub, hub),
      ),
    ),
  );
  return {
    hub,
    layer: ProviderReplayHarness.layerWithRegistry({ name }, registry, {
      runEffectWorker: false,
    }),
    start: Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:agent-bridge"),
        title: "Bridge task",
        modelSelection: { instanceId, model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first"),
        threadId,
        messageId: MessageId.make("message:first"),
        text: "Draft the launch post",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      return (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
    }),
  };
});

const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    ),
  );

it.effect("delivers user messages to the bridge once and completes on a finishing reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { hub, layer, start } = yield* harness("agent-bridge-reply");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const runId = yield* start;

        const first = yield* hub.takeInbox(instanceId);
        assert.deepEqual(
          first.map((task) => [task.threadId, task.messages.map((message) => message.text)]),
          [[threadId, ["Draft the launch post"]]],
        );
        assert.lengthOf(yield* hub.takeInbox(instanceId), 0);

        const posted = yield* watch(
          (event) => event.type === "message.updated" && event.payload.role === "assistant",
        );
        assert.deepEqual(yield* hub.reply({ instanceId, threadId, text: "On it.", done: false }), {
          completed: false,
          unreadMessages: 0,
        });
        yield* Fiber.join(posted);
        const working = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(working.runs[0]?.status, "running");
        assert.deepEqual(
          working.messages.filter((message) => message.role === "assistant").map((m) => m.text),
          ["On it."],
        );

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "Make it shorter",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.deepEqual(
          yield* hub.reply({ instanceId, threadId, text: "Draft ready.", done: true }),
          { completed: false, unreadMessages: 1 },
        );
        const steered = yield* hub.takeInbox(instanceId);
        assert.deepEqual(
          steered.flatMap((task) => task.messages.map((message) => message.text)),
          ["Make it shorter"],
        );

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === runId &&
            event.payload.status !== "running",
        );
        assert.deepEqual(yield* hub.reply({ instanceId, threadId, text: "Shorter.", done: true }), {
          completed: true,
          unreadMessages: 0,
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        const done = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(done.runs[0]?.status, "completed");
        assert.deepEqual(
          done.messages.filter((message) => message.role === "assistant").map((m) => m.text),
          ["On it.", "Draft ready.", "Shorter."],
        );

        const late = yield* hub
          .reply({ instanceId, threadId, text: "One more thing", done: false })
          .pipe(Effect.flip);
        assert.equal(late._tag, "AgentBridgeNoOpenTaskError");
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(AgentBridgeHub.layer)),
);

it.effect("refuses a reply after the user stops the task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { hub, layer, start } = yield* harness("agent-bridge-interrupt");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const runId = yield* start;
        const interrupted = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" && event.payload.status === "interrupted",
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId,
        });
        yield* worker.drain();
        yield* Fiber.join(interrupted);

        const late = yield* hub
          .reply({ instanceId, threadId, text: "Done!", done: true })
          .pipe(Effect.flip);
        assert.equal(late._tag, "AgentBridgeTaskInterruptedError");
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(AgentBridgeHub.layer)),
);

it.effect("answers a shared conversation's turn with preloaded replies, not the inbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { hub, layer, start } = yield* harness("agent-bridge-share");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* hub.preload({ instanceId, threadId, replies: ["Here is a draft.", "Want edits?"] });
        const answered = yield* watch(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* start;
        yield* Fiber.join(answered);
        yield* worker.drain();

        assert.lengthOf(yield* hub.takeInbox(instanceId), 0);
        const done = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(done.runs[0]?.status, "completed");
        assert.deepEqual(
          done.messages.map((message) => [message.role, message.text]),
          [
            ["user", "Draft the launch post"],
            ["assistant", "Here is a draft."],
            ["assistant", "Want edits?"],
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(AgentBridgeHub.layer)),
);

it.effect(
  "returns the user's approval decision to the open task and cancels a card left open",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, layer, start } = yield* harness("agent-bridge-approval");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const runId = yield* start;
          yield* hub.takeInbox(instanceId);

          const shown = yield* watch(
            (event) =>
              event.type === "runtime-request.updated" && event.payload.status === "pending",
          );
          const { requestId } = yield* hub.requestApproval({
            instanceId,
            threadId,
            action: "Send the launch email to jane@acme.com",
            reason: undefined,
          });
          yield* Fiber.join(shown);

          const answered = yield* watch(
            (event) =>
              event.type === "runtime-request.updated" &&
              event.payload.id === requestId &&
              event.payload.status === "resolved",
          );
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("decline"),
            threadId,
            requestId,
            decision: "decline",
            feedback: "Send it to bob@acme.com instead",
          });
          yield* worker.drain();
          yield* Fiber.join(answered);
          assert.deepEqual(
            (yield* hub.takeInbox(instanceId)).flatMap((task) => task.messages.map((m) => m.text)),
            ["Declined: Send the launch email to jane@acme.com\n\nSend it to bob@acme.com instead"],
          );

          const left = yield* hub.requestApproval({
            instanceId,
            threadId,
            action: "Send the launch email to bob@acme.com",
            reason: undefined,
          });
          const cancelled = yield* watch(
            (event) =>
              event.type === "runtime-request.updated" &&
              event.payload.id === left.requestId &&
              event.payload.status === "cancelled",
          );
          const settled = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
              event.payload.status !== "running",
          );
          yield* hub.reply({ instanceId, threadId, text: "Skipped sending.", done: true });
          yield* Fiber.join(cancelled);
          yield* Fiber.join(settled);
          yield* worker.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "completed",
          );
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(AgentBridgeHub.layer)),
);

it.effect(
  "keeps a task cut off by a restart and reopens it with its unread messages and approvals",
  () =>
    Effect.gen(function* () {
      let saved: AgentBridgeHub.AgentBridgeHubState | undefined;
      const store: AgentBridgeHub.AgentBridgeHubStore = {
        load: Effect.sync(() => saved),
        save: (state) =>
          Effect.sync(() => {
            saved = state;
          }),
      };
      const shown: Array<string> = [];
      const turn = (providerTurnId: string, messageId: string): AgentBridgeHub.AgentBridgeTurn => ({
        instanceId,
        threadId,
        providerTurnId: ProviderTurnId.make(providerTurnId),
        message: {
          messageId: MessageId.make(messageId),
          text: "Draft the launch post",
          attachmentNames: [],
          createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
        },
        reply: () => Effect.void,
        requestApproval: ({ action }) =>
          Effect.sync(() => {
            shown.push(action);
            return RuntimeRequestId.make(`request:${shown.length}`);
          }),
      });

      yield* Effect.gen(function* () {
        const hub = yield* AgentBridgeHub.AgentBridgeHub;
        yield* hub.open(turn("turn:1", "message:first"));
        yield* hub.requestApproval({ instanceId, threadId, action: "Send it", reason: undefined });
        yield* hub.detach({ instanceId, threadId, providerTurnId: ProviderTurnId.make("turn:1") });
      }).pipe(Effect.provide(AgentBridgeHub.layerWithStore(store)));

      yield* Effect.gen(function* () {
        const hub = yield* AgentBridgeHub.AgentBridgeHub;
        assert.isDefined(yield* hub.lastSeenAt(instanceId));
        assert.deepEqual(
          (yield* hub.detached).map((task) => [task.threadId, task.unread.length]),
          [[threadId, 1]],
        );
        yield* hub.open(
          turn("turn:2", `${AgentBridgeHub.AGENT_BRIDGE_RESUME_MESSAGE_PREFIX}${threadId}`),
        );
        assert.lengthOf(yield* hub.detached, 0);
        assert.deepEqual(
          (yield* hub.takeInbox(instanceId)).flatMap((task) => task.messages.map((m) => m.text)),
          ["Draft the launch post"],
        );
        assert.deepEqual(shown, ["Send it", "Send it"]);
      }).pipe(Effect.provide(AgentBridgeHub.layerWithStore(store)));
    }),
);

it.effect("hands a collected message back when the agent never writes back on its task", () =>
  Effect.gen(function* () {
    const hub = yield* AgentBridgeHub.AgentBridgeHub;
    yield* hub.open({
      instanceId,
      threadId,
      providerTurnId: ProviderTurnId.make("turn:1"),
      message: {
        messageId: MessageId.make("message:first"),
        text: "Draft the launch post",
        attachmentNames: [],
        createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
      },
      reply: () => Effect.void,
      requestApproval: () => Effect.succeed(RuntimeRequestId.make("request:1")),
    });
    const inbox = Effect.map(hub.takeInbox(instanceId), (tasks) =>
      tasks.map((task) => [task.messages.map((m) => m.text), task.redelivered]),
    );

    assert.deepEqual(yield* inbox, [[["Draft the launch post"], false]]);
    yield* TestClock.adjust(
      Duration.subtract(AgentBridgeHub.AGENT_BRIDGE_REDELIVER_AFTER, Duration.seconds(1)),
    );
    assert.deepEqual(yield* inbox, []);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* inbox, [[["Draft the launch post"], true]]);

    yield* hub.reply({ instanceId, threadId, text: "On it.", done: false });
    yield* TestClock.adjust(AgentBridgeHub.AGENT_BRIDGE_REDELIVER_AFTER);
    assert.deepEqual(yield* inbox, []);
  }).pipe(Effect.provide(AgentBridgeHub.layer)),
);
