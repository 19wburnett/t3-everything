/**
 * Work waiting for hosted agents that cannot be called, only reached over MCP.
 * The adapter opens a task per running turn; the agent collects it and replies.
 * State is in memory, so tasks do not survive a server restart.
 *
 * @module provider-agent-bridge/server/AgentBridgeHub
 */
import {
  type MessageId,
  ProviderInstanceId,
  type ProviderTurnId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class AgentBridgeNoOpenTaskError extends Schema.TaggedError<AgentBridgeNoOpenTaskError>()(
  "AgentBridgeNoOpenTaskError",
  { instanceId: ProviderInstanceId, threadId: ThreadId },
) {
  override get message(): string {
    return "No open task on this thread; the user must send a new message.";
  }
}

export class AgentBridgeTaskInterruptedError extends Schema.TaggedError<AgentBridgeTaskInterruptedError>()(
  "AgentBridgeTaskInterruptedError",
  { instanceId: ProviderInstanceId, threadId: ThreadId },
) {
  override get message(): string {
    return "The user stopped this task; the user must send a new message.";
  }
}

export interface AgentBridgeMessage {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentNames: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
}

export interface AgentBridgeTask {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<AgentBridgeMessage>;
}

export interface AgentBridgeTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly message: AgentBridgeMessage;
  /** Runs under the hub's lock, so it must not call back into the hub. */
  readonly reply: (input: { readonly text: string; readonly done: boolean }) => Effect.Effect<void>;
  /** Shows an approval card; the user's decision returns to the task as a message. */
  readonly requestApproval: (input: {
    readonly action: string;
    readonly reason: string | undefined;
  }) => Effect.Effect<RuntimeRequestId>;
}

interface OpenTask {
  readonly turn: AgentBridgeTurn;
  readonly unread: Array<AgentBridgeMessage>;
}

export class AgentBridgeHub extends Context.Service<
  AgentBridgeHub,
  {
    /** Answers the turn at once with preloaded replies, else waits for the agent. */
    readonly open: (turn: AgentBridgeTurn) => Effect.Effect<void>;
    /** The thread's next turn gets these replies instead of reaching the agent's inbox. */
    readonly preload: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly replies: ReadonlyArray<string>;
    }) => Effect.Effect<void>;
    readonly unpreload: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    /** False when the turn is no longer open. */
    readonly steer: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly message: AgentBridgeMessage;
    }) => Effect.Effect<boolean>;
    /** False when the turn had already ended. */
    readonly close: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly interrupted: boolean;
    }) => Effect.Effect<boolean>;
    /** Returns each open task's unread messages and marks them read. */
    readonly takeInbox: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<AgentBridgeTask>>;
    /** A finishing reply leaves the task open while it has unread messages. */
    readonly reply: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly done: boolean;
    }) => Effect.Effect<
      { readonly completed: boolean; readonly unreadMessages: number },
      AgentBridgeNoOpenTaskError | AgentBridgeTaskInterruptedError
    >;
    readonly requestApproval: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly action: string;
      readonly reason: string | undefined;
    }) => Effect.Effect<
      { readonly requestId: RuntimeRequestId },
      AgentBridgeNoOpenTaskError | AgentBridgeTaskInterruptedError
    >;
    readonly lastSeenAt: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<DateTime.Utc | undefined>;
    /** Resolves once the agent for this instance has called the hub. */
    readonly awaitSeen: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("@t3tools/provider-agent-bridge/server/AgentBridgeHub") {}

const keyOf = (instanceId: ProviderInstanceId, threadId: ThreadId) =>
  JSON.stringify([instanceId, threadId]);

const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const tasks = new Map<string, OpenTask>();
  const interrupted = new Set<string>();
  const preloaded = new Map<string, ReadonlyArray<string>>();
  const seenAt = new Map<ProviderInstanceId, DateTime.Utc>();
  const seenSignals = new Map<ProviderInstanceId, Deferred.Deferred<void>>();

  // Internal helpers share the calling operation's span.
  const seenSignal = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const existing = seenSignals.get(instanceId);
    if (existing) return existing;
    const created = yield* Deferred.make<void>();
    seenSignals.set(instanceId, created);
    return created;
  });
  const markSeen = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    seenAt.set(instanceId, yield* DateTime.now);
    yield* Deferred.succeed(yield* seenSignal(instanceId), undefined);
  });
  const openTask = Effect.fnUntraced(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) {
    yield* markSeen(input.instanceId);
    const key = keyOf(input.instanceId, input.threadId);
    const task = tasks.get(key);
    if (task) return { key, task };
    return yield* interrupted.has(key)
      ? new AgentBridgeTaskInterruptedError(input)
      : new AgentBridgeNoOpenTaskError(input);
  });
  const current = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => {
    const key = keyOf(input.instanceId, input.threadId);
    const task = tasks.get(key);
    return task?.turn.providerTurnId === input.providerTurnId ? { key, task } : undefined;
  };

  return AgentBridgeHub.of({
    open: Effect.fn("AgentBridgeHub.open")(function* (turn) {
      const key = keyOf(turn.instanceId, turn.threadId);
      interrupted.delete(key);
      const replies = preloaded.get(key);
      if (replies === undefined) {
        tasks.set(key, { turn, unread: [turn.message] });
        return;
      }
      preloaded.delete(key);
      if (replies.length === 0) yield* turn.reply({ text: "", done: true });
      for (const [index, text] of replies.entries()) {
        yield* turn.reply({ text, done: index === replies.length - 1 });
      }
    }, lock.withPermits(1)),
    preload: Effect.fn("AgentBridgeHub.preload")(function (input) {
      return Effect.sync(() => {
        preloaded.set(keyOf(input.instanceId, input.threadId), input.replies);
      });
    }, lock.withPermits(1)),
    unpreload: Effect.fn("AgentBridgeHub.unpreload")(function (input) {
      return Effect.sync(() => {
        preloaded.delete(keyOf(input.instanceId, input.threadId));
      });
    }, lock.withPermits(1)),
    steer: Effect.fn("AgentBridgeHub.steer")(function (input) {
      return Effect.sync(() => {
        const open = current(input);
        if (!open) return false;
        open.task.unread.push(input.message);
        return true;
      });
    }, lock.withPermits(1)),
    close: Effect.fn("AgentBridgeHub.close")(function (input) {
      return Effect.sync(() => {
        const open = current(input);
        if (!open) return false;
        tasks.delete(open.key);
        if (input.interrupted) interrupted.add(open.key);
        return true;
      });
    }, lock.withPermits(1)),
    takeInbox: Effect.fn("AgentBridgeHub.takeInbox")(function* (instanceId) {
      yield* markSeen(instanceId);
      const inbox: Array<AgentBridgeTask> = [];
      for (const { turn, unread } of tasks.values()) {
        if (turn.instanceId !== instanceId || unread.length === 0) continue;
        inbox.push({ threadId: turn.threadId, messages: unread.splice(0) });
      }
      return inbox;
    }, lock.withPermits(1)),
    reply: Effect.fn("AgentBridgeHub.reply")(function* (input) {
      const { key, task } = yield* openTask(input);
      const completed = input.done && task.unread.length === 0;
      yield* task.turn.reply({ text: input.text, done: completed });
      if (completed) tasks.delete(key);
      return { completed, unreadMessages: task.unread.length };
    }, lock.withPermits(1)),
    requestApproval: Effect.fn("AgentBridgeHub.requestApproval")(function* (input) {
      const { task } = yield* openTask(input);
      const requestId = yield* task.turn.requestApproval({
        action: input.action,
        reason: input.reason,
      });
      return { requestId };
    }, lock.withPermits(1)),
    lastSeenAt: Effect.fn("AgentBridgeHub.lastSeenAt")(function (instanceId) {
      return Effect.sync(() => seenAt.get(instanceId));
    }),
    awaitSeen: Effect.fn("AgentBridgeHub.awaitSeen")(function* (instanceId) {
      yield* Deferred.await(yield* seenSignal(instanceId).pipe(lock.withPermits(1)));
    }),
  });
});

export const layer = Layer.effect(AgentBridgeHub, make);
