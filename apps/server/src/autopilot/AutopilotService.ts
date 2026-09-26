// @effect-diagnostics globalDate:off - timestamps are ISO strings for contracts.
// @effect-diagnostics globalDateInEffect:off - same; the current time itself comes from Clock.
/**
 * AutopilotService - `/autopilot <goal>` for every provider (T3-Snow).
 *
 * While Autopilot is on, every turn the thread's agent receives starts with
 * the Autopilot instructions (through ThreadTurnPreamble), and questions the
 * agent asks are answered for it. It turns itself off once the thread is
 * settled: no turn running, nothing waiting to be delivered, no helpers
 * running and no wake-ups armed. It never approves tool calls.
 *
 * State lives in memory and is mirrored to `<stateDir>/autopilot.json`. After
 * a restart, a thread that still had Autopilot on shows it as paused until the
 * user resumes or stops it.
 *
 * @module autopilot/AutopilotService
 */
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  UserInputQuestion,
  type AutopilotSnapshot,
  type AutopilotStartResult,
  type AutopilotStatus,
  type OrchestrationEvent,
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
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as DeferService from "../defer/DeferService.ts";
import * as HelperService from "../helpers/HelperService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import {
  AUTOPILOT_RESUME_MESSAGE,
  buildAutopilotAnswers,
  buildAutopilotGoalMessage,
  buildAutopilotInstructions,
  normalizeAutopilotGoal,
} from "./autopilotFormat.ts";

const STATE_FILE_NAME = "autopilot.json";
const PREAMBLE_KEY = "autopilot";
/** Safety net for a settle that no event announced, e.g. a wake-up cancelled while idle. */
const SWEEP_INTERVAL = "30 seconds";

export const AUTOPILOT_USAGE = "Usage: /autopilot <end goal>";
export const AUTOPILOT_BUSY =
  "Autopilot can start only when no other agent work is active or queued.";

export class AutopilotService extends Context.Service<
  AutopilotService,
  {
    readonly start: (threadId: ThreadId, goal: string) => Effect.Effect<AutopilotStartResult>;
    /** Turns Autopilot off and interrupts the running turn. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Turns a paused Autopilot back on and nudges the agent to continue. */
    readonly resume: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly streamChanges: Stream.Stream<AutopilotSnapshot>;
  }
>()("t3/autopilot/AutopilotService") {}

interface ThreadAutopilot {
  readonly goal: string;
  /** ISO time the goal (or the resume) was sent; its turn must end before Autopilot can. */
  since: string;
  readonly startedAt: string;
  status: AutopilotStatus;
}

const PersistedStates = Schema.Array(
  Schema.Struct({ threadId: Schema.String, goal: Schema.String, startedAt: Schema.String }),
);
const decodePersistedStates = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedStates));
const encodePersistedStates = Schema.encodeEffect(Schema.fromJsonString(PersistedStates));

const UserInputRequestedPayload = Schema.Struct({
  requestId: ApprovalRequestId,
  questions: Schema.Array(UserInputQuestion),
  responseMode: Schema.optional(Schema.Literal("message")),
});
const decodeUserInputRequested = Schema.decodeUnknownOption(UserInputRequestedPayload);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const wakeQueue = yield* ThreadWakeQueue.ThreadWakeQueue;
  const preamble = yield* ThreadTurnPreamble.ThreadTurnPreamble;
  const helpers = yield* Effect.serviceOption(HelperService.HelperService);
  const defer = yield* Effect.serviceOption(DeferService.DeferService);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const statePath = path.join(serverConfig.stateDir, STATE_FILE_NAME);
  const states = new Map<ThreadId, ThreadAutopilot>();
  const lock = yield* Semaphore.make(1);
  const changes = yield* SubscriptionRef.make<AutopilotSnapshot>({ threads: [] });
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const isoNow = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString());

  const recordChange = Effect.suspend(() => {
    const entries = [...states.entries()].map(([threadId, state]) => ({
      threadId,
      goal: state.goal,
      startedAt: state.startedAt,
    }));
    const save = (
      entries.length === 0
        ? fileSystem.remove(statePath, { force: true })
        : encodePersistedStates(entries).pipe(
            Effect.flatMap((json) => fileSystem.writeFileString(statePath, `${json}\n`)),
          )
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("autopilot: could not save state", { cause })),
    );
    return Effect.andThen(
      save,
      SubscriptionRef.set(changes, {
        threads: [...states.entries()].map(([threadId, state]) => ({
          threadId,
          goal: state.goal,
          startedAt: state.startedAt,
          status: state.status,
        })),
      }),
    );
  });

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("autopilot: command failed", { type: command.type, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const appendActivity = (threadId: ThreadId, kind: string, summary: string, payload: unknown) =>
    Effect.gen(function* () {
      const createdAt = yield* isoNow;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:autopilot-activity:${yield* uuid}`),
        threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind,
          summary,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });

  const otherWorkPending = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (yield* wakeQueue.hasPending(threadId)) return true;
      if (Option.isSome(helpers) && (yield* helpers.value.hasRunning(threadId))) return true;
      if (Option.isSome(defer) && (yield* defer.value.hasArmed(threadId))) return true;
      return false;
    });

  const clear = (threadId: ThreadId) =>
    Effect.gen(function* () {
      states.delete(threadId);
      yield* preamble.setStanding(threadId, PREAMBLE_KEY, null);
      yield* recordChange;
    });

  const start: AutopilotService["Service"]["start"] = (threadId, rawGoal) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = normalizeAutopilotGoal(rawGoal);
        if (!goal) return { started: false, message: AUTOPILOT_USAGE };
        const thread = yield* readShell(threadId);
        if (!thread || thread.archivedAt !== null) {
          return { started: false, message: "This thread is not available." };
        }
        if (states.get(threadId)?.status === "active") {
          return { started: false, message: "Autopilot is already on in this thread." };
        }
        if (
          ThreadWakeQueue.isThreadBusy(thread) ||
          thread.backgroundLiveness ||
          (yield* otherWorkPending(threadId))
        ) {
          return { started: false, message: AUTOPILOT_BUSY };
        }

        const startedAt = yield* isoNow;
        states.set(threadId, { goal, since: startedAt, startedAt, status: "active" });
        yield* preamble.setStanding(threadId, PREAMBLE_KEY, buildAutopilotInstructions(goal));
        const sent = yield* dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:autopilot-goal:${yield* uuid}`),
          threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: buildAutopilotGoalMessage(goal),
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          // Autopilot works toward a finished result, not a plan to review.
          interactionMode: "default",
          createdAt: startedAt,
        });
        if (!sent) {
          yield* clear(threadId);
          return { started: false, message: "T3 Code could not send the goal; try again." };
        }
        yield* recordChange;
        yield* appendActivity(threadId, "autopilot.started", "Autopilot on", { goal });
        return thread.runtimeMode === "approval-required"
          ? {
              started: true,
              message:
                "Autopilot may stop at approval prompts; switch to Auto or Full access to let it run unattended.",
            }
          : { started: true };
      }),
    );

  const stop: AutopilotService["Service"]["stop"] = (threadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!states.has(threadId)) return false;
        yield* clear(threadId);
        const thread = yield* readShell(threadId);
        if (thread && ThreadWakeQueue.isThreadBusy(thread)) {
          yield* dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`server:autopilot-stop:${yield* uuid}`),
            threadId,
            createdAt: yield* isoNow,
          });
        }
        yield* appendActivity(threadId, "autopilot.stopped", "Autopilot stopped", {});
        return true;
      }),
    );

  const resume: AutopilotService["Service"]["resume"] = (threadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = states.get(threadId);
        if (!state || state.status !== "paused") return false;
        state.status = "active";
        state.since = yield* isoNow;
        yield* preamble.setStanding(threadId, PREAMBLE_KEY, buildAutopilotInstructions(state.goal));
        yield* recordChange;
        yield* wakeQueue.deliver({ threadId, text: AUTOPILOT_RESUME_MESSAGE, source: "autopilot" });
        return true;
      }),
    );

  /** Turns Autopilot off once the thread has nothing left running or coming. */
  const checkSettled = (threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = states.get(threadId);
        if (!state || state.status !== "active") return;
        const thread = yield* readShell(threadId);
        if (!thread || thread.archivedAt !== null) return yield* clear(threadId);
        const turn = thread.latestTurn;
        // The goal (or resume) turn has to have started and ended first.
        if (!turn || turn.requestedAt < state.since) return;
        if (ThreadWakeQueue.isThreadBusy(thread) || thread.backgroundLiveness) return;
        if (yield* otherWorkPending(threadId)) return;
        yield* clear(threadId);
        const interrupted = turn.state === "interrupted";
        yield* appendActivity(
          threadId,
          interrupted ? "autopilot.stopped" : "autopilot.finished",
          interrupted ? "Autopilot stopped: the turn was interrupted" : "Autopilot finished",
          {},
        );
      }),
    );

  const answerQuestion = (threadId: ThreadId, payload: unknown) =>
    Effect.gen(function* () {
      if (states.get(threadId)?.status !== "active") return;
      const request = decodeUserInputRequested(payload);
      if (Option.isNone(request)) return;
      const { requestId, questions, responseMode } = request.value;
      const answered = yield* dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make(`server:autopilot-answer:${yield* uuid}`),
        threadId,
        requestId,
        answers: buildAutopilotAnswers(questions, responseMode),
        createdAt: yield* isoNow,
      });
      if (!answered) return;
      for (const question of questions) {
        yield* appendActivity(
          threadId,
          "autopilot.answered",
          `Autopilot answered a question itself: ${question.question}`,
          { requestId },
        );
      }
    });

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.session-set":
        return states.has(event.payload.threadId)
          ? checkSettled(event.payload.threadId)
          : Effect.void;
      case "thread.activity-appended":
        return event.payload.activity.kind === "user-input.requested"
          ? answerQuestion(event.payload.threadId, event.payload.activity.payload)
          : Effect.void;
      case "thread.deleted":
      case "thread.archived":
        return states.has(event.payload.threadId)
          ? lock.withPermits(1)(clear(event.payload.threadId))
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  // Autopilot that was on when T3 Code stopped comes back paused.
  const restore = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) return;
    const saved = yield* decodePersistedStates(raw.value).pipe(Effect.orElseSucceed(() => []));
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        for (const entry of saved) {
          states.set(entry.threadId as ThreadId, {
            goal: entry.goal,
            since: entry.startedAt,
            startedAt: entry.startedAt,
            status: "paused",
          });
        }
        yield* recordChange;
      }),
    );
  });

  yield* restore;
  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(Stream.runForEach(events, onEvent));
  yield* forkParked(
    Effect.suspend(() => Effect.forEach([...states.keys()], checkSettled, { discard: true })).pipe(
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.asVoid,
    ),
  );

  return AutopilotService.of({
    start,
    stop,
    resume,
    streamChanges: SubscriptionRef.changes(changes),
  });
});

export const layer = Layer.effect(AutopilotService, make);
