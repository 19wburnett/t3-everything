/**
 * Work waiting for hosted agents that cannot be called, only reached over MCP.
 * The adapter opens a task per running turn; the agent collects it and replies.
 * With a store, tasks a restart cut off are kept for the server to reopen.
 *
 * @module provider-agent-bridge/server/AgentBridgeHub
 */
import {
  IsoDateTime,
  MessageId,
  ProviderInstanceId,
  type ProviderTurnId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
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
  /** Handed over before without a reply since, so the agent may have acted on it already. */
  readonly redelivered: boolean;
}

export interface AgentBridgeApproval {
  readonly action: string;
  readonly reason: string | undefined;
}

export interface AgentBridgeTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly message: AgentBridgeMessage;
  /** Runs under the hub's lock, so it must not call back into the hub. */
  readonly reply: (input: { readonly text: string; readonly done: boolean }) => Effect.Effect<void>;
  /** Shows an approval card; the user's decision returns to the task as a message. */
  readonly requestApproval: (input: AgentBridgeApproval) => Effect.Effect<RuntimeRequestId>;
}

/** The thread's next turn reopens a task saved when a restart cut it off. */
export const AGENT_BRIDGE_RESUME_MESSAGE_PREFIX = "message:agent-bridge-resume:";

const StoredMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachmentNames: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
});

const StoredTask = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  unread: Schema.Array(StoredMessage),
  approvals: Schema.Array(
    Schema.Struct({ action: Schema.String, reason: Schema.optional(Schema.String) }),
  ),
});
export type AgentBridgeStoredTask = typeof StoredTask.Type;

export const AgentBridgeHubState = Schema.Struct({
  seenAt: Schema.Record(Schema.String, IsoDateTime),
  tasks: Schema.Array(StoredTask),
});
export type AgentBridgeHubState = typeof AgentBridgeHubState.Type;

export interface AgentBridgeHubStore {
  readonly load: Effect.Effect<AgentBridgeHubState | undefined>;
  readonly save: (state: AgentBridgeHubState) => Effect.Effect<void>;
}

/** Messages taken from the inbox return to it when the agent has not written back by then. */
export const AGENT_BRIDGE_REDELIVER_AFTER = Duration.minutes(10);

interface OpenTask {
  readonly turn: AgentBridgeTurn;
  readonly unread: Array<AgentBridgeMessage>;
  /** Taken but not yet acknowledged by a reply or approval request. */
  delivered:
    | { readonly messages: Array<AgentBridgeMessage>; readonly at: DateTime.Utc }
    | undefined;
  readonly approvals: Map<RuntimeRequestId, AgentBridgeApproval>;
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
    /** Records the user's decision and queues it for the agent; false when the turn ended. */
    readonly decide: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly requestId: RuntimeRequestId;
      readonly message: AgentBridgeMessage;
    }) => Effect.Effect<boolean>;
    /** False when the turn had already ended. */
    readonly close: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly interrupted: boolean;
    }) => Effect.Effect<boolean>;
    /** The session went away with the turn still open, as on shutdown; the store keeps the task. */
    readonly detach: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
    }) => Effect.Effect<void>;
    /** Tasks a restart cut off, waiting to be reopened. */
    readonly detached: Effect.Effect<ReadonlyArray<AgentBridgeStoredTask>>;
    readonly forgetDetached: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    /** Returns each open task's unread messages; they come back if the agent never writes back. */
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
    /** Resolves on the agent's next call to the hub. */
    readonly awaitSeen: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("@t3tools/provider-agent-bridge/server/AgentBridgeHub") {}

const keyOf = (instanceId: ProviderInstanceId, threadId: ThreadId) =>
  JSON.stringify([instanceId, threadId]);

const toStoredMessage = (message: AgentBridgeMessage) => ({
  messageId: message.messageId,
  text: message.text,
  attachmentNames: message.attachmentNames,
  createdAt: DateTime.formatIso(message.createdAt),
});

const fromStoredMessage = (message: AgentBridgeStoredTask["unread"][number]) => ({
  messageId: message.messageId,
  text: message.text,
  attachmentNames: message.attachmentNames,
  createdAt: DateTime.makeUnsafe(message.createdAt),
});

const make = Effect.fn("AgentBridgeHub.make")(function* (store: AgentBridgeHubStore | undefined) {
  const lock = yield* Semaphore.make(1);
  const tasks = new Map<string, OpenTask>();
  const interrupted = new Set<string>();
  const preloaded = new Map<string, ReadonlyArray<string>>();
  const seenAt = new Map<ProviderInstanceId, DateTime.Utc>();
  const seenSignals = new Map<ProviderInstanceId, Deferred.Deferred<void>>();
  const detached = new Map<string, AgentBridgeStoredTask>();

  const loaded = store ? yield* store.load : undefined;
  for (const [instanceId, at] of Object.entries(loaded?.seenAt ?? {})) {
    seenAt.set(ProviderInstanceId.make(instanceId), DateTime.makeUnsafe(at));
  }
  for (const task of loaded?.tasks ?? []) {
    detached.set(keyOf(task.instanceId, task.threadId), task);
  }

  // Internal helpers share the calling operation's span.
  const persist = Effect.fnUntraced(function* () {
    if (!store) return;
    const open: Array<AgentBridgeStoredTask> = [...tasks.values()].map((task) => ({
      instanceId: task.turn.instanceId,
      threadId: task.turn.threadId,
      unread: [...(task.delivered?.messages ?? []), ...task.unread].map(toStoredMessage),
      approvals: [...task.approvals.values()].map((approval) => ({
        action: approval.action,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      })),
    }));
    yield* store.save({
      seenAt: Object.fromEntries(
        [...seenAt].map(([instanceId, at]) => [instanceId, DateTime.formatIso(at)]),
      ),
      tasks: [...open, ...detached.values()],
    });
  });
  const seenSignal = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const existing = seenSignals.get(instanceId);
    if (existing) return existing;
    const created = yield* Deferred.make<void>();
    seenSignals.set(instanceId, created);
    return created;
  });
  const markSeen = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    seenAt.set(instanceId, yield* DateTime.now);
    const signal = yield* seenSignal(instanceId);
    seenSignals.delete(instanceId);
    yield* Deferred.succeed(signal, undefined);
  });
  const openTask = Effect.fnUntraced(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) {
    yield* markSeen(input.instanceId);
    const key = keyOf(input.instanceId, input.threadId);
    const task = tasks.get(key);
    if (task) {
      task.delivered = undefined;
      return { key, task };
    }
    yield* persist();
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
      if (replies !== undefined) {
        preloaded.delete(key);
        if (replies.length === 0) yield* turn.reply({ text: "", done: true });
        for (const [index, text] of replies.entries()) {
          yield* turn.reply({ text, done: index === replies.length - 1 });
        }
        return;
      }
      const saved = detached.get(key);
      detached.delete(key);
      const resuming = turn.message.messageId.startsWith(AGENT_BRIDGE_RESUME_MESSAGE_PREFIX);
      const task: OpenTask = {
        turn,
        unread: [
          ...(saved?.unread.map(fromStoredMessage) ?? []),
          ...(resuming ? [] : [turn.message]),
        ],
        delivered: undefined,
        approvals: new Map(),
      };
      tasks.set(key, task);
      for (const approval of saved?.approvals ?? []) {
        const restored = { action: approval.action, reason: approval.reason };
        task.approvals.set(yield* turn.requestApproval(restored), restored);
      }
      yield* persist();
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
    steer: Effect.fn("AgentBridgeHub.steer")(function* (input) {
      const open = current(input);
      if (!open) return false;
      open.task.unread.push(input.message);
      yield* persist();
      return true;
    }, lock.withPermits(1)),
    decide: Effect.fn("AgentBridgeHub.decide")(function* (input) {
      const open = current(input);
      if (!open) return false;
      open.task.approvals.delete(input.requestId);
      open.task.unread.push(input.message);
      yield* persist();
      return true;
    }, lock.withPermits(1)),
    close: Effect.fn("AgentBridgeHub.close")(function* (input) {
      const open = current(input);
      if (!open) return false;
      tasks.delete(open.key);
      if (input.interrupted) interrupted.add(open.key);
      yield* persist();
      return true;
    }, lock.withPermits(1)),
    detach: Effect.fn("AgentBridgeHub.detach")(function* (input) {
      const open = current(input);
      if (!open) return;
      tasks.delete(open.key);
      if (!store) return;
      // Persist before forgetting: shutdown may not run another save.
      detached.set(open.key, {
        instanceId: input.instanceId,
        threadId: input.threadId,
        unread: [...(open.task.delivered?.messages ?? []), ...open.task.unread].map(
          toStoredMessage,
        ),
        approvals: [...open.task.approvals.values()].map((approval) => ({
          action: approval.action,
          ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        })),
      });
      yield* persist();
    }, lock.withPermits(1)),
    detached: Effect.sync(() => [...detached.values()]).pipe(lock.withPermits(1)),
    forgetDetached: Effect.fn("AgentBridgeHub.forgetDetached")(function* (input) {
      if (!detached.delete(keyOf(input.instanceId, input.threadId))) return;
      yield* persist();
    }, lock.withPermits(1)),
    takeInbox: Effect.fn("AgentBridgeHub.takeInbox")(function* (instanceId) {
      yield* markSeen(instanceId);
      const now = yield* DateTime.now;
      const redeliverBefore = DateTime.subtractDuration(now, AGENT_BRIDGE_REDELIVER_AFTER);
      const inbox: Array<AgentBridgeTask> = [];
      for (const task of tasks.values()) {
        if (task.turn.instanceId !== instanceId) continue;
        const stale =
          task.delivered && DateTime.isLessThanOrEqualTo(task.delivered.at, redeliverBefore)
            ? task.delivered.messages
            : [];
        if (stale.length === 0 && task.unread.length === 0) continue;
        const messages = [...stale, ...task.unread.splice(0)];
        task.delivered = {
          messages: [...(stale.length > 0 ? [] : (task.delivered?.messages ?? [])), ...messages],
          at: now,
        };
        inbox.push({ threadId: task.turn.threadId, messages, redelivered: stale.length > 0 });
      }
      yield* persist();
      return inbox;
    }, lock.withPermits(1)),
    reply: Effect.fn("AgentBridgeHub.reply")(function* (input) {
      const { key, task } = yield* openTask(input);
      const completed = input.done && task.unread.length === 0;
      yield* task.turn.reply({ text: input.text, done: completed });
      if (completed) tasks.delete(key);
      yield* persist();
      return { completed, unreadMessages: task.unread.length };
    }, lock.withPermits(1)),
    requestApproval: Effect.fn("AgentBridgeHub.requestApproval")(function* (input) {
      const { task } = yield* openTask(input);
      const approval = { action: input.action, reason: input.reason };
      const requestId = yield* task.turn.requestApproval(approval);
      task.approvals.set(requestId, approval);
      yield* persist();
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

export const layer = Layer.effect(AgentBridgeHub, make(undefined));

export const layerWithStore = (store: AgentBridgeHubStore) =>
  Layer.effect(AgentBridgeHub, make(store));
