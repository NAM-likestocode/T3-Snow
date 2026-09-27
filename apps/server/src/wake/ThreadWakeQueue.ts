// @effect-diagnostics globalDateInEffect:off - createdAt stamps use the Clock time.
/**
 * ThreadWakeQueue - deliver server-authored messages to a thread when it is idle (T3-Snow).
 *
 * Wake-ups, helper reports, and Autopilot nudges all post a user message into
 * an agent's thread. Sending while a turn runs would steer that turn, so each
 * message waits here until the thread is idle, with no pending approval or
 * question, then starts a turn of its own. One message goes out per idle
 * moment; the rest follow as each of those turns ends.
 *
 * Waiting messages are mirrored to `<stateDir>/wake-queue.json` and reloaded
 * at startup, so a restart never drops one that had not gone out yet.
 *
 * @module wake/ThreadWakeQueue
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

const STATE_FILE_NAME = "wake-queue.json";
const PersistedQueue = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Struct({ text: Schema.String, source: Schema.String })),
);
const decodePersistedQueue = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedQueue));
const encodePersistedQueue = Schema.encodeEffect(Schema.fromJsonString(PersistedQueue));

/** A dispatched message that never produced a running session frees its slot after this. */
const DELIVERY_STALL_MS = 2 * 60_000;
/** Safety net for session events a subscriber might miss. */
const DELIVERY_SWEEP_INTERVAL = "30 seconds";

export class ThreadWakeQueue extends Context.Service<
  ThreadWakeQueue,
  {
    /**
     * Queues `text` for the thread and sends it as soon as the thread is idle.
     * `source` only labels the command id and logs (`defer`, `helper`, ...).
     */
    readonly deliver: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly source: string;
    }) => Effect.Effect<void>;
    /** Whether the thread has messages waiting or one just sent and not finished. */
    readonly hasPending: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/wake/ThreadWakeQueue") {}

export function isThreadBusy(thread: OrchestrationThreadShell): boolean {
  const status = thread.session?.status;
  return (
    status === "starting" ||
    status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  );
}

interface QueuedMessage {
  readonly text: string;
  readonly source: string;
}

type Delivery = { readonly phase: "requested" | "running"; readonly since: number };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const statePath = path.join(serverConfig.stateDir, STATE_FILE_NAME);

  const pending = new Map<ThreadId, QueuedMessage[]>();
  const deliveries = new Map<ThreadId, Delivery>();
  const lock = yield* Semaphore.make(1);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const persist = Effect.suspend(() =>
    (pending.size === 0
      ? fileSystem.remove(statePath, { force: true })
      : encodePersistedQueue(Object.fromEntries(pending)).pipe(
          Effect.flatMap((json) => fileSystem.writeFileString(statePath, `${json}\n`)),
        )
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("wake: could not save waiting messages", { cause }),
      ),
    ),
  );

  const flush = (threadId: ThreadId): Effect.Effect<void> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const queue = pending.get(threadId);
        if (!queue || queue.length === 0) {
          if (pending.delete(threadId)) yield* persist;
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const delivery = deliveries.get(threadId);
        if (delivery && now - delivery.since < DELIVERY_STALL_MS) return;
        deliveries.delete(threadId);

        const thread = yield* readThread(threadId);
        if (!thread || thread.archivedAt !== null) {
          pending.delete(threadId);
          yield* persist;
          return;
        }
        if (isThreadBusy(thread)) return;

        const next = queue.shift()!;
        if (queue.length === 0) pending.delete(threadId);
        yield* persist;
        const createdAt = new Date(now).toISOString();
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:${next.source}-wake:${yield* uuid}`),
            threadId,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text: next.text,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => deliveries.set(threadId, { phase: "requested", since: now })),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("wake: message could not be delivered", {
                threadId,
                source: next.source,
                cause,
              }),
            ),
          );
      }),
    );

  const deliver: ThreadWakeQueue["Service"]["deliver"] = ({ threadId, text, source }) =>
    Effect.suspend(() => {
      const queue = pending.get(threadId) ?? [];
      queue.push({ text, source });
      pending.set(threadId, queue);
      return Effect.andThen(persist, flush(threadId));
    });

  const hasPending: ThreadWakeQueue["Service"]["hasPending"] = (threadId) =>
    Effect.sync(() => pending.has(threadId) || deliveries.get(threadId)?.phase === "requested");

  const onSessionSet = (threadId: ThreadId, status: string) =>
    Effect.suspend(() => {
      const delivery = deliveries.get(threadId);
      if (status === "running" || status === "starting") {
        if (delivery?.phase === "requested") {
          deliveries.set(threadId, { phase: "running", since: delivery.since });
        }
        return Effect.void;
      }
      // The delivered message's turn has ended (or never ran); the thread is free again.
      if (delivery?.phase === "running") deliveries.delete(threadId);
      return pending.has(threadId) ? flush(threadId) : Effect.void;
    });

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.session-set":
        return onSessionSet(event.payload.threadId, event.payload.session.status);
      case "thread.deleted":
      case "thread.archived":
        return Effect.suspend(() => {
          deliveries.delete(event.payload.threadId);
          return pending.delete(event.payload.threadId) ? persist : Effect.void;
        });
      default:
        return Effect.void;
    }
  };

  // Messages still waiting when T3 Code stopped go out as their threads come free.
  const saved = yield* fileSystem
    .readFileString(statePath)
    .pipe(Effect.flatMap(decodePersistedQueue), Effect.option);
  if (Option.isSome(saved)) {
    for (const [threadId, messages] of Object.entries(saved.value)) {
      if (messages.length > 0) pending.set(threadId as ThreadId, [...messages]);
    }
  }

  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(Stream.runForEach(events, onEvent));
  yield* forkParked(
    Effect.suspend(() => Effect.forEach([...pending.keys()], flush, { discard: true })).pipe(
      Effect.repeat(Schedule.spaced(DELIVERY_SWEEP_INTERVAL)),
      Effect.asVoid,
    ),
  );

  return ThreadWakeQueue.of({ deliver, hasPending });
});

export const layer = Layer.effect(ThreadWakeQueue, make);
