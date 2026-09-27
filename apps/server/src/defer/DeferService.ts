// @effect-diagnostics globalDate:off - timestamps are formatted for the agent in local time.
// @effect-diagnostics globalDateInEffect:off - same; the current time itself comes from Clock.
/**
 * DeferService - deferred wake-ups for agents (T3-Snow).
 *
 * An agent arms a trigger through the `defer` MCP tool: a time (`at`), a
 * shell condition polled until it exits 0 (`check`), and optionally a command
 * whose output is attached when it fires (`run`). When a trigger fires, the
 * service posts a user message into the agent's thread, which starts a new
 * turn. Behavior, limits, and wording follow the Pi `defer` extension.
 *
 * Delivery goes through ThreadWakeQueue, so a wake-up never interrupts a
 * running turn: it waits until the thread is idle, then goes out on its own.
 *
 * Triggers live in memory. Their id, thread, and note are mirrored to
 * `<stateDir>/defer-triggers.json`; after a restart each trigger that never
 * fired is reported to its thread as lost, so nothing disappears silently,
 * while no stale command is ever re-run.
 *
 * @module defer/DeferService
 */
import {
  CommandId,
  EventId,
  type DeferTrigger,
  type DeferTriggersSnapshot,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import {
  DEFER_CHECK_RUN_TIMEOUT_MS,
  DEFER_DEFAULT_POLL_MS,
  DEFER_DEFAULT_TIMEOUT_MS,
  DEFER_MAX_CAPTURE_BYTES,
  DEFER_MAX_TIMEOUT_MS,
  DEFER_MAX_TRIGGERS_PER_THREAD,
  DEFER_MAX_FIRES_PER_HOUR,
  DEFER_MAX_TRIGGERS_TOTAL,
  DEFER_MIN_DELAY_MS,
  DEFER_NOT_RUN_EXIT_CODE,
  DEFER_MIN_POLL_MS,
  DEFER_RUN_TIMEOUT_MS,
  DEFER_TIMED_OUT_EXIT_CODE,
  buildDeferLostMessage,
  buildDeferWakeMessage,
  formatCompactDuration,
  makeDeferTriggerId,
  parseDeferTime,
  type DeferFireReason,
  type DeferRunResult,
} from "./deferFormat.ts";

const STATE_FILE_NAME = "defer-triggers.json";

/**
 * Commands run on the host outside any provider sandbox, so only threads the
 * user put in Full access may use them. Checked when arming and again before
 * every command, in case the user changed the mode since.
 */
const COMMAND_RUNTIME_MODE = "full-access";

export class DeferRequestError extends Schema.TaggedError<DeferRequestError>()(
  "DeferRequestError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface DeferCreateInput {
  readonly threadId: ThreadId;
  readonly note?: string | undefined;
  readonly at?: string | undefined;
  readonly check?: string | undefined;
  readonly run?: string | undefined;
  readonly pollMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export class DeferService extends Context.Service<
  DeferService,
  {
    /** Arms a trigger; resolves to Pi's confirmation line. */
    readonly create: (input: DeferCreateInput) => Effect.Effect<string, DeferRequestError>;
    /** Pi's one-line-per-trigger listing for one thread. */
    readonly list: (threadId: ThreadId) => Effect.Effect<string>;
    /** Cancels one of the thread's triggers, as the agent. */
    readonly cancel: (threadId: ThreadId, id: string) => Effect.Effect<string, DeferRequestError>;
    /** Cancels any trigger by id, as the user. */
    readonly cancelById: (id: string) => Effect.Effect<boolean>;
    /** Whether the thread has triggers still armed. */
    readonly hasArmed: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Every armed trigger now, then after each change. */
    readonly streamChanges: Stream.Stream<DeferTriggersSnapshot>;
  }
>()("t3/defer/DeferService") {}

interface ArmedTrigger {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly kind: "at" | "check";
  readonly note: string;
  readonly armedAt: number;
  /** `at`: fire time. `check`: deadline. */
  readonly firesAt: number;
  readonly check: string | undefined;
  readonly run: string | undefined;
  readonly pollMs: number;
  readonly cwd: string | undefined;
  checks: number;
  lastExit: number | null;
  lastLine: string | null;
  fiber: Fiber.Fiber<void> | null;
}

const PersistedTriggers = Schema.Array(
  Schema.Struct({ id: Schema.String, threadId: Schema.String, note: Schema.String }),
);
type PersistedTrigger = (typeof PersistedTriggers.Type)[number];
const decodePersistedTriggers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedTriggers),
);
const encodePersistedTriggers = Schema.encodeEffect(Schema.fromJsonString(PersistedTriggers));

function toSnapshotEntry(trigger: ArmedTrigger): DeferTrigger {
  return {
    id: trigger.id,
    threadId: trigger.threadId,
    kind: trigger.kind,
    note: trigger.note,
    armedAt: new Date(trigger.armedAt).toISOString(),
    firesAt: new Date(trigger.firesAt).toISOString(),
    ...(trigger.check === undefined ? {} : { check: trigger.check }),
    ...(trigger.run === undefined ? {} : { run: trigger.run }),
    ...(trigger.kind === "check" ? { pollMs: trigger.pollMs } : {}),
    checks: trigger.checks,
    lastExit: trigger.lastExit,
  };
}

function describeListEntry(trigger: ArmedTrigger, now: number): string {
  const runTag = trigger.run ? ` →run \`${trigger.run}\`` : "";
  if (trigger.kind === "at") {
    return `${trigger.id} — ${trigger.note} [at ${new Date(trigger.firesAt).toLocaleString()}]${runTag}`;
  }
  const lastLine = trigger.lastLine ? ` (${trigger.lastLine.slice(0, 60)})` : "";
  const lastExit = trigger.lastExit === null ? "–" : String(trigger.lastExit);
  return `${trigger.id} — ${trigger.note} [when \`${trigger.check}\` succeeds (deadline ${new Date(
    trigger.firesAt,
  ).toLocaleString()})] — ${trigger.checks} checks, last exit ${lastExit}${lastLine}, ${formatCompactDuration(
    Math.max(0, trigger.firesAt - now),
  )} left${runTag}`;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const wakeQueue = yield* ThreadWakeQueue.ThreadWakeQueue;
  const scope = yield* Effect.scope;

  const statePath = path.join(serverConfig.stateDir, STATE_FILE_NAME);
  const triggers = new Map<string, ArmedTrigger>();
  /** Fire times per thread over the last hour, for the loop guard. */
  const recentFires = new Map<ThreadId, number[]>();
  const triggerLock = yield* Semaphore.make(1);
  const changes = yield* SubscriptionRef.make<DeferTriggersSnapshot>({ triggers: [] });

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowMs = Clock.currentTimeMillis;

  // --- persistence and change feed -----------------------------------------

  const persist = Effect.suspend(() => {
    const entries: PersistedTrigger[] = [...triggers.values()].map((trigger) => ({
      id: trigger.id,
      threadId: trigger.threadId,
      note: trigger.note,
    }));
    return (
      entries.length === 0
        ? fileSystem.remove(statePath, { force: true })
        : encodePersistedTriggers(entries).pipe(
            Effect.flatMap((json) => fileSystem.writeFileString(statePath, `${json}\n`)),
          )
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("defer: could not save armed triggers", { cause }),
      ),
    );
  });

  const publish = SubscriptionRef.set(changes, {
    triggers: [...triggers.values()]
      .toSorted((left, right) => left.firesAt - right.firesAt)
      .map(toSnapshotEntry),
  });

  const recordChange = Effect.andThen(persist, publish);

  // --- thread helpers --------------------------------------------------------

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const resolveCwd = Effect.fn("DeferService.resolveCwd")(function* (
    thread: OrchestrationThreadShell,
  ) {
    if (thread.worktreePath) return thread.worktreePath;
    const project = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(project) ? project.value.workspaceRoot : undefined;
  });

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const createdAt = new Date(yield* nowMs).toISOString();
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:defer-activity:${yield* uuid}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("defer: activity not recorded", { cause })),
    );

  const deliver = (threadId: ThreadId, text: string) =>
    wakeQueue.deliver({ threadId, text, source: "defer" });

  // --- running commands ------------------------------------------------------

  const shell = yield* Effect.cached(
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const env = yield* HostProcessEnvironment;
      if (platform === "win32") {
        const candidates = [
          env.ProgramFiles,
          env.ProgramW6432,
          env["ProgramFiles(x86)"],
          env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined,
        ]
          .filter((root): root is string => Boolean(root))
          .map((root) => path.join(root, "Git", "bin", "bash.exe"));
        for (const candidate of candidates) {
          if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
            return { command: candidate, args: ["-c"] } as const;
          }
        }
        return {
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command"],
        } as const;
      }
      const hasBash = yield* fileSystem.exists("/bin/bash").pipe(Effect.orElseSucceed(() => false));
      return { command: hasBash ? "/bin/bash" : "/bin/sh", args: ["-c"] } as const;
    }),
  );

  const runShell = Effect.fn("DeferService.runShell")(function* (
    command: string,
    cwd: string | undefined,
    timeoutMs: number,
  ) {
    const { command: executable, args } = yield* shell;
    return yield* processRunner
      .run({
        command: executable,
        args: [...args, command],
        cwd,
        stdin: "",
        timeout: Duration.millis(timeoutMs),
        maxOutputBytes: DEFER_MAX_CAPTURE_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) => {
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
          return result.timedOut
            ? {
                exitCode: DEFER_TIMED_OUT_EXIT_CODE,
                output: `${output}\n(timed out after ${timeoutMs}ms)`.trim(),
              }
            : { exitCode: result.code === null ? 1 : Number(result.code), output };
        }),
        Effect.catchCause((cause) =>
          Effect.succeed({
            exitCode: 127,
            output: `Could not run the command: ${cause.toString().slice(0, 300)}`,
          }),
        ),
      );
  });

  // --- trigger lifecycle -----------------------------------------------------

  const fire = Effect.fn("DeferService.fire")(function* (
    trigger: ArmedTrigger,
    reason: DeferFireReason,
  ) {
    yield* triggerLock.withPermits(1)(
      Effect.suspend(() => {
        if (triggers.get(trigger.id) !== trigger) return Effect.void;
        triggers.delete(trigger.id);
        return recordChange;
      }),
    );
    const now = yield* nowMs;
    recentFires.set(trigger.threadId, [...firesInLastHour(trigger.threadId, now), now]);
    let run: DeferRunResult | undefined;
    if (trigger.run) {
      run = (yield* commandsAllowed(trigger.threadId))
        ? {
            command: trigger.run,
            ...(yield* runShell(trigger.run, trigger.cwd, DEFER_RUN_TIMEOUT_MS)),
          }
        : {
            command: trigger.run,
            exitCode: DEFER_NOT_RUN_EXIT_CODE,
            output: "Not run: this thread is no longer in Full access mode.",
          };
    }
    yield* Effect.logInfo("defer: trigger fired", {
      threadId: trigger.threadId,
      triggerId: trigger.id,
      reason: reason.kind,
    });
    yield* deliver(
      trigger.threadId,
      buildDeferWakeMessage({ id: trigger.id, reason, note: trigger.note, run }),
    );
  });

  const watch = (trigger: ArmedTrigger): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (trigger.kind === "at") {
        yield* Effect.sleep(Duration.millis(Math.max(0, trigger.firesAt - (yield* nowMs))));
        return yield* fire(trigger, { kind: "due" });
      }
      let delay = Math.min(trigger.pollMs, 1_000);
      while (true) {
        const remaining = trigger.firesAt - (yield* nowMs);
        if (remaining <= 0) break;
        yield* Effect.sleep(Duration.millis(Math.min(delay, remaining)));
        if ((yield* nowMs) >= trigger.firesAt) break;
        if (!(yield* commandsAllowed(trigger.threadId))) {
          return yield* fire(trigger, { kind: "blocked", check: trigger.check! });
        }
        const result = yield* runShell(trigger.check!, trigger.cwd, DEFER_CHECK_RUN_TIMEOUT_MS);
        trigger.checks += 1;
        trigger.lastExit = result.exitCode;
        trigger.lastLine =
          result.output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .findLast((line) => line.length > 0) ?? null;
        yield* publish;
        if (result.exitCode === 0) {
          return yield* fire(trigger, {
            kind: "condition",
            check: trigger.check!,
            afterMs: (yield* nowMs) - trigger.armedAt,
          });
        }
        delay = trigger.pollMs;
      }
      yield* fire(trigger, {
        kind: "timeout",
        afterMs: (yield* nowMs) - trigger.armedAt,
        checks: trigger.checks,
        lastExit: trigger.lastExit,
      });
    });

  const reject = (detail: string) => Effect.fail(new DeferRequestError({ detail }));

  const firesInLastHour = (threadId: ThreadId, now: number) =>
    (recentFires.get(threadId) ?? []).filter((at) => now - at < 60 * 60_000);

  const commandsAllowed = (threadId: ThreadId) =>
    readThread(threadId).pipe(Effect.map((thread) => thread?.runtimeMode === COMMAND_RUNTIME_MODE));

  const create: DeferService["Service"]["create"] = Effect.fn("DeferService.create")(
    function* (input) {
      const note = input.note?.trim() ?? "";
      const at = input.at?.trim() || undefined;
      const check = input.check?.trim() || undefined;
      const run = input.run?.trim() || undefined;
      if (!note) return yield* reject("create requires a note");
      if (!at && !check && !run) return yield* reject("create requires at, check, or run");
      if (run && !at && !check) {
        return yield* reject(
          "`run` needs `at` or `check` to say when it fires — to run something now, use bash",
        );
      }

      const now = yield* nowMs;
      let firesAt: number | undefined;
      if (at) {
        const parsed = parseDeferTime(at, new Date(now));
        if (!parsed) return yield* reject(`could not understand time: ${at}`);
        firesAt = parsed.getTime();
      }

      const thread = yield* readThread(input.threadId);
      if (!thread) return yield* reject("this thread no longer exists");
      if ((check || run) && thread.runtimeMode !== COMMAND_RUNTIME_MODE) {
        return yield* reject(
          "`check` and `run` need this thread in Full access mode, because T3 Code runs them on the host without a sandbox or approval. Use `at` and check manually, or ask the user to switch modes.",
        );
      }
      if (firesInLastHour(input.threadId, now).length >= DEFER_MAX_FIRES_PER_HOUR) {
        return yield* reject(
          `this thread has already been woken ${DEFER_MAX_FIRES_PER_HOUR} times in the last hour; finish the work or ask the user before arming more wake-ups`,
        );
      }
      // A wake-up can never fire sooner than this, so it cannot drive a tight loop.
      if (firesAt !== undefined) firesAt = Math.max(firesAt, now + DEFER_MIN_DELAY_MS);
      const cwd = yield* resolveCwd(thread);

      const pollMs = Math.max(DEFER_MIN_POLL_MS, input.pollMs ?? DEFER_DEFAULT_POLL_MS);
      const timeoutMs = Math.min(DEFER_MAX_TIMEOUT_MS, input.timeoutMs ?? DEFER_DEFAULT_TIMEOUT_MS);
      const kind = check ? "check" : "at";
      // With a check, `at` is the deadline: the check-in time the agent chose.
      const deadline = kind === "check" ? (firesAt ?? now + timeoutMs) : firesAt!;

      const trigger = yield* triggerLock.withPermits(1)(
        Effect.gen(function* () {
          const threadCount = [...triggers.values()].filter(
            (entry) => entry.threadId === input.threadId,
          ).length;
          if (threadCount >= DEFER_MAX_TRIGGERS_PER_THREAD) {
            return yield* reject(
              `this thread already has ${DEFER_MAX_TRIGGERS_PER_THREAD} armed triggers; cancel one first`,
            );
          }
          if (triggers.size >= DEFER_MAX_TRIGGERS_TOTAL) {
            return yield* reject("too many triggers are armed on this machine; cancel some first");
          }
          let id = makeDeferTriggerId();
          while (triggers.has(id)) id = makeDeferTriggerId();
          const armed: ArmedTrigger = {
            id,
            threadId: input.threadId,
            kind,
            note,
            armedAt: now,
            firesAt: deadline,
            check,
            run,
            pollMs,
            cwd,
            checks: 0,
            lastExit: null,
            lastLine: null,
            fiber: null,
          };
          triggers.set(id, armed);
          armed.fiber = yield* Effect.forkIn(watch(armed), scope);
          yield* recordChange;
          return armed;
        }),
      );

      yield* Effect.logInfo("defer: trigger armed", {
        threadId: input.threadId,
        triggerId: trigger.id,
        kind,
      });
      const when =
        kind === "at" ? `at ${new Date(deadline).toLocaleTimeString()}` : `when \`${check}\``;
      yield* appendActivity({
        threadId: input.threadId,
        kind: "defer.armed",
        summary: `Wake-up ${trigger.id} armed ${when}`,
        payload: { triggerId: trigger.id, note, firesAt: new Date(deadline).toISOString() },
      });
      return `Armed ${trigger.id} ${when}${run ? `, runs \`${run}\`` : ""}`;
    },
  );

  const list: DeferService["Service"]["list"] = (threadId) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const entries = [...triggers.values()]
        .filter((trigger) => trigger.threadId === threadId)
        .toSorted((left, right) => left.firesAt - right.firesAt);
      if (entries.length === 0) return "No deferred triggers armed.";
      return entries.map((trigger) => describeListEntry(trigger, now)).join("\n");
    });

  const remove = (trigger: ArmedTrigger, by: "agent" | "user") =>
    Effect.gen(function* () {
      triggers.delete(trigger.id);
      if (trigger.fiber) yield* Fiber.interrupt(trigger.fiber);
      yield* recordChange;
      yield* appendActivity({
        threadId: trigger.threadId,
        kind: "defer.cancelled",
        summary: `Wake-up ${trigger.id} cancelled${by === "user" ? " by you" : ""}`,
        payload: { triggerId: trigger.id, note: trigger.note },
      });
    });

  const cancel: DeferService["Service"]["cancel"] = (threadId, id) =>
    triggerLock.withPermits(1)(
      Effect.gen(function* () {
        if (!id.trim()) return yield* reject("cancel requires id");
        const trigger = triggers.get(id.trim());
        if (!trigger || trigger.threadId !== threadId) {
          return yield* reject(`no armed trigger with id ${id.trim()}`);
        }
        yield* remove(trigger, "agent");
        return `Cancelled ${trigger.id} — ${trigger.note}`;
      }),
    );

  const cancelById: DeferService["Service"]["cancelById"] = (id) =>
    triggerLock.withPermits(1)(
      Effect.gen(function* () {
        const trigger = triggers.get(id);
        if (!trigger) return false;
        yield* remove(trigger, "user");
        return true;
      }),
    );

  const cancelThread = (threadId: ThreadId) =>
    triggerLock.withPermits(1)(
      Effect.gen(function* () {
        const owned = [...triggers.values()].filter((trigger) => trigger.threadId === threadId);
        if (owned.length === 0) return;
        for (const trigger of owned) {
          triggers.delete(trigger.id);
          if (trigger.fiber) yield* Fiber.interrupt(trigger.fiber);
        }
        yield* recordChange;
      }),
    );

  // --- background work -------------------------------------------------------

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.deleted":
      case "thread.archived":
        return cancelThread(event.payload.threadId);
      default:
        return Effect.void;
    }
  };

  const reportLostTriggers = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) return;
    yield* fileSystem.remove(statePath, { force: true }).pipe(Effect.ignore);
    const lost = yield* decodePersistedTriggers(raw.value).pipe(Effect.orElseSucceed(() => []));
    for (const entry of lost) {
      yield* deliver(
        entry.threadId as ThreadId,
        buildDeferLostMessage({ id: entry.id, note: entry.note }),
      );
    }
  });

  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(Stream.runForEach(events, onEvent));
  yield* forkParked(reportLostTriggers);

  return DeferService.of({
    create,
    list,
    cancel,
    cancelById,
    hasArmed: (threadId) =>
      Effect.sync(() => [...triggers.values()].some((trigger) => trigger.threadId === threadId)),
    streamChanges: SubscriptionRef.changes(changes),
  });
});

export const layer = Layer.effect(DeferService, make).pipe(Layer.provide(ProcessRunner.layer));

export type { Scope };
