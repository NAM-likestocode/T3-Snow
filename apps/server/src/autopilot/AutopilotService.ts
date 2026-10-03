// @effect-diagnostics globalDate:off - timestamps are ISO strings for contracts.
// @effect-diagnostics globalDateInEffect:off - same; the current time itself comes from Clock.
/**
 * AutopilotService - `/autopilot <goal>` for every provider (T3-Snow).
 *
 * While Autopilot is on, every turn the thread's agent receives starts with
 * the Autopilot instructions (through ThreadTurnPreamble), and questions the
 * agent asks are answered for it. It turns itself off once the thread is
 * settled: no turn running, nothing waiting to be delivered, and no
 * wake-ups armed. It never approves tool calls.
 *
 * It pauses itself after AUTOPILOT_MAX_TURNS runs or AUTOPILOT_MAX_DURATION_MS,
 * whichever comes first; Resume starts a fresh budget.
 *
 * State lives in memory and is mirrored to `<stateDir>/autopilot.json`. After
 * a restart, a thread that still had Autopilot on shows it as paused until the
 * user resumes or stops it.
 *
 * @module autopilot/AutopilotService
 */
import {
  CommandId,
  MessageId,
  type AutopilotSnapshot,
  type AutopilotStartResult,
  type AutopilotStatus,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
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
/** Autopilot pauses itself after this many runs or this long, whichever comes first. */
export const AUTOPILOT_MAX_TURNS = 100;
export const AUTOPILOT_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

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
  /** When the goal (or the resume) was sent; a run requested after it must end first. */
  since: number;
  readonly startedAt: string;
  status: AutopilotStatus;
  /** Budget since the last start or resume. */
  turns: number;
}

const PersistedStates = Schema.Array(
  Schema.Struct({ threadId: Schema.String, goal: Schema.String, startedAt: Schema.String }),
);
const decodePersistedStates = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedStates));
const encodePersistedStates = Schema.encodeEffect(Schema.fromJsonString(PersistedStates));

const millis = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.toEpochMillis(value) : null;

/** Work the agent still has going in the thread, apart from wake-ups. */
const isThreadBusy = (thread: OrchestrationV2ThreadShell) =>
  thread.activeRunId !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0;

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const preamble = yield* ThreadTurnPreamble.ThreadTurnPreamble;
  const defer = yield* Effect.serviceOption(DeferService.DeferService);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const statePath = path.join(serverConfig.stateDir, STATE_FILE_NAME);
  const states = new Map<ThreadId, ThreadAutopilot>();
  /** Questions already answered, so a later update of the same item is not answered again. */
  const answered = new Set<string>();
  const lock = yield* Semaphore.make(1);
  const changes = yield* SubscriptionRef.make<AutopilotSnapshot>({ threads: [] });
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

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

  /** The thread, or undefined once it is gone or archived. */
  const readShell = (threadId: ThreadId) =>
    engine.getThreadShell(threadId).pipe(
      Effect.map((thread) => (thread && thread.archivedAt === null ? thread : undefined)),
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

  /** Sends text as a user message; it waits behind any running turn. */
  const send = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const id = yield* uuid;
      return yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:autopilot:${threadId}:${id}`),
        threadId,
        messageId: MessageId.make(`message:autopilot:${id}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
    });

  const wakeUpsArmed = (threadId: ThreadId) =>
    Option.isSome(defer) ? defer.value.hasArmed(threadId) : Effect.succeed(false);

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
        if (!thread) return { started: false, message: "This thread is not available." };
        if (states.get(threadId)?.status === "active") {
          return { started: false, message: "Autopilot is already on in this thread." };
        }
        if (isThreadBusy(thread) || (yield* wakeUpsArmed(threadId))) {
          return { started: false, message: AUTOPILOT_BUSY };
        }

        const now = yield* Clock.currentTimeMillis;
        states.set(threadId, {
          goal,
          since: now,
          startedAt: new Date(now).toISOString(),
          status: "active",
          turns: 0,
        });
        yield* preamble.setStanding(threadId, PREAMBLE_KEY, buildAutopilotInstructions(goal));
        if (!(yield* send(threadId, buildAutopilotGoalMessage(goal)))) {
          yield* clear(threadId);
          return { started: false, message: "T3 Code could not send the goal; try again." };
        }
        yield* recordChange;
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
        if (thread?.activeRunId) {
          yield* dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`server:autopilot-stop:${threadId}:${yield* uuid}`),
            threadId,
            runId: thread.activeRunId,
            reason: "Autopilot stopped",
          });
        }
        return true;
      }),
    );

  const resume: AutopilotService["Service"]["resume"] = (threadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = states.get(threadId);
        if (!state || state.status !== "paused") return false;
        state.status = "active";
        state.since = yield* Clock.currentTimeMillis;
        state.turns = 0;
        yield* preamble.setStanding(threadId, PREAMBLE_KEY, buildAutopilotInstructions(state.goal));
        yield* recordChange;
        yield* send(threadId, AUTOPILOT_RESUME_MESSAGE);
        return true;
      }),
    );

  /** Stops steering the agent until the user resumes; the running turn finishes normally. */
  const pause = (threadId: ThreadId, state: ThreadAutopilot) =>
    Effect.gen(function* () {
      state.status = "paused";
      yield* preamble.setStanding(threadId, PREAMBLE_KEY, null);
      yield* recordChange;
    });

  /** Pauses on budget, and turns Autopilot off once the thread has nothing left to do. */
  const check = (threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = states.get(threadId);
        if (!state || state.status !== "active") return;
        const thread = yield* readShell(threadId);
        if (!thread) return yield* clear(threadId);
        const elapsed = (yield* Clock.currentTimeMillis) - state.since;
        if (state.turns > AUTOPILOT_MAX_TURNS || elapsed >= AUTOPILOT_MAX_DURATION_MS) {
          return yield* pause(threadId, state);
        }
        // The goal (or resume) run has to have started and ended first.
        const requestedAt = millis(thread.latestRunRequestedAt);
        if (requestedAt === null || requestedAt < state.since) return;
        if (isThreadBusy(thread) || (yield* wakeUpsArmed(threadId))) return;
        yield* clear(threadId);
      }),
    );

  const answerQuestion = (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>,
  ) =>
    Effect.gen(function* () {
      const item = event.payload;
      if (item.type !== "user_input_request") return;
      if (states.get(event.threadId)?.status !== "active") return;
      if (item.status !== "pending" && item.status !== "waiting") return;
      if (answered.has(item.requestId)) return;
      answered.add(item.requestId);
      yield* dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`server:autopilot-answer:${event.threadId}:${yield* uuid}`),
        threadId: event.threadId,
        requestId: item.requestId,
        answers: buildAutopilotAnswers(item.questions, item.responseMode),
      });
    });

  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    if (!states.has(event.threadId)) return Effect.void;
    switch (event.type) {
      case "run.created": {
        const state = states.get(event.threadId);
        if (state?.status === "active") state.turns += 1;
        return check(event.threadId);
      }
      case "run.updated":
        return check(event.threadId);
      case "turn-item.updated":
        return answerQuestion(event);
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
            since: Date.parse(entry.startedAt),
            startedAt: entry.startedAt,
            status: "paused",
            turns: 0,
          });
        }
        yield* recordChange;
      }),
    );
  });

  yield* restore;
  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
      Effect.catchCause((cause) => Effect.logWarning("autopilot: event stream failed", { cause })),
    ),
  );
  yield* forkParked(
    Effect.suspend(() => Effect.forEach([...states.keys()], check, { discard: true })).pipe(
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
