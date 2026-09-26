// @effect-diagnostics globalDate:off - timestamps are ISO strings for contracts and messages.
// @effect-diagnostics globalDateInEffect:off - same; the current time itself comes from Clock.
/**
 * HelperService - helpers on any model for any thread (T3-Snow).
 *
 * An agent hands a task to a helper through the `subagent` MCP tool. The
 * helper runs as its own thread in the same project, on the model the agent
 * names or the "Helper model" setting, with the parent thread's permissions
 * (read-only profiles run in plan mode). When the helper's turn ends, its
 * final message goes back to the parent through ThreadWakeQueue, so it never
 * interrupts a running turn. Behavior and wording follow the Pi `subagent`
 * tool.
 *
 * Runs live in memory. Running ones are mirrored to
 * `<stateDir>/helper-runs.json`; after a restart each one is reported to its
 * parent as failed, so nothing disappears silently.
 *
 * @module helpers/HelperService
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type HelperRun,
  type HelperRunsSnapshot,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
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
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import {
  HELPER_MAX_DEPTH,
  HELPER_MAX_RUNNING,
  HELPER_MAX_TASK_CHARS,
  HELPER_MAX_WAIT_MS,
  HELPER_RECENT_RUNS,
  buildHelperReportMessage,
  buildHelperStartedMessage,
  buildHelperTaskMessage,
  describeHelperRun,
  makeHelperRunId,
  type HelperRunStatus,
} from "./helperFormat.ts";
import { listHelperModelNames, resolveHelperModel } from "./helperModels.ts";
import {
  DEFAULT_HELPER_PROFILE,
  mergeHelperProfiles,
  parseHelperProfile,
  type HelperProfile,
  type HelperProfileSource,
} from "./helperProfiles.ts";

const STATE_FILE_NAME = "helper-runs.json";
const PROJECT_PROFILE_DIRS = [".t3/agents", ".claude/agents", ".pi/agents"] as const;
/** Safety net for child events a subscriber might miss. */
const SWEEP_INTERVAL = "30 seconds";

export class HelperRequestError extends Schema.TaggedError<HelperRequestError>()(
  "HelperRequestError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface HelperStartInput {
  readonly threadId: ThreadId;
  readonly task: string;
  readonly reason?: string | undefined;
  readonly agent?: string | undefined;
  readonly name?: string | undefined;
  readonly mode?: "background" | "wait" | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly instructions?: string | undefined;
}

export class HelperService extends Context.Service<
  HelperService,
  {
    /** Starts a helper; resolves to Pi's started line, or the report in wait mode. */
    readonly start: (input: HelperStartInput) => Effect.Effect<string, HelperRequestError>;
    /** The thread's helpers, the profiles it can use, and the usable models. */
    readonly list: (threadId: ThreadId) => Effect.Effect<string>;
    /** Stops one of the thread's helpers (or `all`), as the agent. */
    readonly stop: (threadId: ThreadId, id: string) => Effect.Effect<string, HelperRequestError>;
    /** Stops any helper by id, as the user. */
    readonly stopById: (id: string) => Effect.Effect<boolean>;
    /** Whether the thread has helpers still running. */
    readonly hasRunning: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Running and recently finished helpers now, then after each change. */
    readonly streamChanges: Stream.Stream<HelperRunsSnapshot>;
  }
>()("t3/helpers/HelperService") {}

interface Run {
  readonly id: string;
  readonly parentThreadId: ThreadId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly profile: string;
  readonly model: string;
  readonly depth: number;
  readonly startedAt: number;
  status: HelperRunStatus;
  finishedAt: number | null;
  /** A `wait` caller still waiting for the report. */
  waiter: Deferred.Deferred<string> | null;
}

const PersistedRuns = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    parentThreadId: Schema.String,
    threadId: Schema.String,
    name: Schema.String,
    model: Schema.String,
  }),
);
type PersistedRun = (typeof PersistedRuns.Type)[number];
const decodePersistedRuns = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedRuns));
const encodePersistedRuns = Schema.encodeEffect(Schema.fromJsonString(PersistedRuns));

function toSnapshotEntry(run: Run): HelperRun {
  return {
    id: run.id,
    parentThreadId: run.parentThreadId,
    threadId: run.threadId,
    name: run.name,
    profile: run.profile,
    model: run.model,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
  };
}

/** The helper's answer: its last finished assistant message, else its latest plan. */
export function extractHelperReport(thread: OrchestrationThread): string {
  const turnId = thread.latestTurn?.turnId ?? null;
  const assistant = thread.messages.filter(
    (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
  );
  const fromTurn = assistant.filter((message) => turnId !== null && message.turnId === turnId);
  const message = fromTurn.at(-1) ?? assistant.at(-1);
  if (message) return message.text;
  return thread.proposedPlans.at(-1)?.planMarkdown ?? "";
}

function isChildBusy(thread: OrchestrationThreadShell): boolean {
  return ThreadWakeQueue.isThreadBusy(thread) || Boolean(thread.backgroundLiveness);
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const wakeQueue = yield* ThreadWakeQueue.ThreadWakeQueue;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const statePath = path.join(serverConfig.stateDir, STATE_FILE_NAME);
  const runs = new Map<string, Run>();
  const runByThread = new Map<ThreadId, Run>();
  const lock = yield* Semaphore.make(1);
  const changes = yield* SubscriptionRef.make<HelperRunsSnapshot>({ runs: [] });

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowMs = Clock.currentTimeMillis;
  const isoNow = Effect.map(nowMs, (now) => new Date(now).toISOString());

  // --- persistence and change feed -----------------------------------------

  const persist = Effect.suspend(() => {
    const entries: PersistedRun[] = [...runs.values()]
      .filter((run) => run.status === "running")
      .map((run) => ({
        id: run.id,
        parentThreadId: run.parentThreadId,
        threadId: run.threadId,
        name: run.name,
        model: run.model,
      }));
    return (
      entries.length === 0
        ? fileSystem.remove(statePath, { force: true })
        : encodePersistedRuns(entries).pipe(
            Effect.flatMap((json) => fileSystem.writeFileString(statePath, `${json}\n`)),
          )
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("helpers: could not save running helpers", { cause }),
      ),
    );
  });

  const recordChange = Effect.suspend(() => {
    // Keep every running helper and the most recent finished ones.
    const finished = [...runs.values()]
      .filter((run) => run.status !== "running")
      .toSorted((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
    for (const run of finished.slice(HELPER_RECENT_RUNS)) runs.delete(run.id);
    return Effect.andThen(
      persist,
      SubscriptionRef.set(changes, {
        runs: [...runs.values()]
          .toSorted((left, right) => left.startedAt - right.startedAt)
          .map(toSnapshotEntry),
      }),
    );
  });

  // --- thread helpers --------------------------------------------------------

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const readDetail = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("helpers: command failed", { type: command.type, cause }),
      ),
    );

  const appendActivity = (threadId: ThreadId, kind: string, summary: string, payload: unknown) =>
    Effect.gen(function* () {
      const createdAt = yield* isoNow;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:helper-activity:${yield* uuid}`),
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

  // --- profiles --------------------------------------------------------------

  const readProfileDir = (directory: string, source: HelperProfileSource) =>
    Effect.gen(function* () {
      const names = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const profiles: HelperProfile[] = [];
      for (const name of names.filter((entry) => entry.toLowerCase().endsWith(".md")).toSorted()) {
        const text = yield* fileSystem
          .readFileString(path.join(directory, name))
          .pipe(Effect.orElseSucceed(() => ""));
        const profile = text ? parseHelperProfile(text, name, source) : undefined;
        if (profile) profiles.push(profile);
      }
      return profiles;
    });

  const loadProfiles = (workspaceRoot: string | undefined) =>
    Effect.gen(function* () {
      const user = yield* readProfileDir(path.join(serverConfig.baseDir, "agents"), "user");
      const project: HelperProfile[] = [];
      if (workspaceRoot) {
        for (const directory of PROJECT_PROFILE_DIRS) {
          project.push(...(yield* readProfileDir(path.join(workspaceRoot, directory), "project")));
        }
      }
      return mergeHelperProfiles({ user, project });
    });

  const workspaceRootFor = (thread: OrchestrationThreadShell) =>
    snapshots.getProjectShellById(thread.projectId).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  // --- finishing -------------------------------------------------------------

  const finish = (
    run: Run,
    status: Exclude<HelperRunStatus, "running">,
    options: { readonly report?: string; readonly deliver: boolean },
  ) =>
    Effect.gen(function* () {
      if (run.status !== "running") return;
      const now = yield* nowMs;
      run.status = status;
      run.finishedAt = now;
      runByThread.delete(run.threadId);

      const detail = yield* readDetail(run.threadId);
      const report = options.report ?? (detail ? extractHelperReport(detail) : "");
      const toolCalls =
        detail?.activities.filter((activity) => activity.kind === "tool.completed").length ?? 0;
      const message = buildHelperReportMessage({
        name: run.name,
        status,
        durationMs: now - run.startedAt,
        toolCalls,
        model: run.model,
        runId: run.id,
        report,
      });
      yield* recordChange;
      yield* Effect.logInfo("helpers: helper finished", { runId: run.id, status });
      yield* appendActivity(
        run.parentThreadId,
        "helper.finished",
        `Helper "${run.name}" ${status}`,
        { runId: run.id, threadId: run.threadId, status },
      );
      const waiter = run.waiter;
      run.waiter = null;
      if (waiter) {
        yield* Deferred.succeed(waiter, message);
      } else if (options.deliver) {
        yield* wakeQueue.deliver({ threadId: run.parentThreadId, text: message, source: "helper" });
      }
    });

  /** Finishes the run when its thread has gone quiet after working. */
  const checkRun = (run: Run) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (run.status !== "running") return;
        const thread = yield* readShell(run.threadId);
        if (!thread || thread.archivedAt !== null) {
          return yield* finish(run, "stopped", {
            report: "The helper's thread was deleted or archived before it finished.",
            deliver: true,
          });
        }
        if (isChildBusy(thread)) return;
        if (thread.session?.status === "error" && thread.latestTurn?.state !== "completed") {
          return yield* finish(run, "failed", {
            report: `The helper could not run: ${thread.session.lastError ?? "its provider reported an error"}.`,
            deliver: true,
          });
        }
        // No turn yet means the task message has not started one.
        const turn = thread.latestTurn;
        if (!turn) return;
        if (turn.state === "completed") return yield* finish(run, "completed", { deliver: true });
        if (turn.state === "error") return yield* finish(run, "failed", { deliver: true });
        if (turn.state === "interrupted") return yield* finish(run, "stopped", { deliver: true });
      }),
    );

  const stopRun = (run: Run, by: "agent" | "user" | "parent") =>
    Effect.gen(function* () {
      const createdAt = yield* isoNow;
      yield* dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`server:helper-stop:${yield* uuid}`),
        threadId: run.threadId,
        createdAt,
      });
      yield* dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`server:helper-stop:${yield* uuid}`),
        threadId: run.threadId,
        createdAt,
      });
      yield* lock.withPermits(1)(
        finish(run, "stopped", {
          report:
            by === "user"
              ? "The user stopped this helper before it finished. Its thread shows the work so far."
              : "Stopped before it finished.",
          // The agent knows it stopped the helper; a deleted parent has nobody to tell.
          deliver: by === "user",
        }),
      );
    });

  // --- starting --------------------------------------------------------------

  const reject = (detail: string) => Effect.fail(new HelperRequestError({ detail }));

  const start: HelperService["Service"]["start"] = Effect.fn("HelperService.start")(
    function* (input) {
      const task = input.task.trim();
      if (!task) return yield* reject("task is required");
      if (task.length > HELPER_MAX_TASK_CHARS) {
        return yield* reject(
          `task is ${task.length} characters; keep it under ${HELPER_MAX_TASK_CHARS} and point to files instead of pasting them`,
        );
      }
      const parent = yield* readShell(input.threadId);
      if (!parent) return yield* reject("this thread no longer exists");

      const depth = (runByThread.get(input.threadId)?.depth ?? 0) + 1;
      if (depth > HELPER_MAX_DEPTH) {
        return yield* reject(
          `helpers can nest only ${HELPER_MAX_DEPTH} levels deep; do this part yourself`,
        );
      }

      const profiles = yield* loadProfiles(yield* workspaceRootFor(parent));
      const profileName = (input.agent?.trim() || DEFAULT_HELPER_PROFILE).toLowerCase();
      const profile = profiles.find((entry) => entry.name === profileName);
      if (!profile) {
        return yield* reject(
          `no helper profile named "${profileName}"; available: ${profiles.map((entry) => entry.name).join(", ")}`,
        );
      }

      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => new HelperRequestError({ detail: "could not read settings" })),
      );
      const resolved = resolveHelperModel({
        providers: yield* providerRegistry.getProviders,
        defaultSelection: settings.helperModelSelection,
        requested: input.model?.trim() || profile.model,
        effort: input.effort?.trim() || profile.effort,
      });
      if (!resolved.ok) return yield* reject(resolved.error);

      const name = (input.name?.trim() || profile.name).slice(0, 60);
      const run = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const running = [...runs.values()].filter((entry) => entry.status === "running");
          if (running.length >= HELPER_MAX_RUNNING) {
            return yield* reject(
              `${HELPER_MAX_RUNNING} helpers are already running on this machine; wait for one to finish or stop one`,
            );
          }
          let id = makeHelperRunId();
          while (runs.has(id)) id = makeHelperRunId();
          const created: Run = {
            id,
            parentThreadId: input.threadId,
            threadId: ThreadId.make(yield* uuid),
            name,
            profile: profile.name,
            model: resolved.label,
            depth,
            startedAt: yield* nowMs,
            status: "running",
            finishedAt: null,
            waiter: input.mode === "wait" ? yield* Deferred.make<string>() : null,
          };
          runs.set(id, created);
          runByThread.set(created.threadId, created);
          return created;
        }),
      );

      const interactionMode = profile.readOnly ? "plan" : "default";
      const createdAt = yield* isoNow;
      const launched = yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:helper-create:${yield* uuid}`),
          threadId: run.threadId,
          projectId: parent.projectId,
          title: `↳ ${name}`,
          modelSelection: resolved.selection,
          runtimeMode: parent.runtimeMode,
          interactionMode,
          // The helper works in the parent's checkout. No branch, so its first
          // turn never renames the branch the parent is on.
          branch: null,
          worktreePath: parent.worktreePath,
          createdAt,
        })
        .pipe(
          Effect.andThen(
            Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`server:helper-task:${yield* uuid}`),
                threadId: run.threadId,
                message: {
                  messageId: MessageId.make(yield* uuid),
                  role: "user",
                  text: buildHelperTaskMessage({
                    name,
                    profileInstructions: profile.instructions,
                    readOnly: profile.readOnly,
                    extraInstructions: input.instructions,
                    task,
                  }),
                  attachments: [],
                },
                modelSelection: resolved.selection,
                runtimeMode: parent.runtimeMode,
                interactionMode,
                createdAt,
              });
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("helpers: could not start helper", { cause }).pipe(Effect.as(false)),
          ),
        );
      if (!launched) {
        yield* lock.withPermits(1)(
          Effect.sync(() => {
            runs.delete(run.id);
            runByThread.delete(run.threadId);
          }),
        );
        return yield* reject("T3 Code could not start the helper's thread; try again");
      }

      yield* lock.withPermits(1)(recordChange);
      yield* Effect.logInfo("helpers: helper started", {
        runId: run.id,
        parentThreadId: input.threadId,
        model: resolved.label,
        depth,
      });
      yield* appendActivity(
        input.threadId,
        "helper.started",
        `Helper "${name}" started (${profile.name}; ${resolved.label})`,
        { runId: run.id, threadId: run.threadId, reason: input.reason ?? null },
      );

      const started = buildHelperStartedMessage({
        name,
        profile: profile.name,
        model: resolved.label,
        runId: run.id,
      });
      if (!run.waiter) return started;
      const waiter = run.waiter;
      const report = yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(Duration.millis(HELPER_MAX_WAIT_MS)),
      );
      if (Option.isSome(report)) return report.value;
      // Still working: stop waiting so the report arrives as a message instead.
      const stillWaiting = yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (run.waiter !== waiter) return false;
          run.waiter = null;
          return true;
        }),
      );
      if (!stillWaiting) return yield* Deferred.await(waiter);
      return `${started}\n(Waited ${HELPER_MAX_WAIT_MS / 1_000}s, the most a tool call can safely wait; it is still running.)`;
    },
  );

  // --- listing and stopping ---------------------------------------------------

  const list: HelperService["Service"]["list"] = (threadId) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const own = [...runs.values()].filter((run) => run.parentThreadId === threadId);
      const runLines = own.map((run) =>
        describeHelperRun({
          runId: run.id,
          name: run.name,
          profile: run.profile,
          model: run.model,
          status: run.status,
          elapsedMs: (run.finishedAt ?? now) - run.startedAt,
        }),
      );
      const parent = yield* readShell(threadId);
      const profiles = yield* loadProfiles(parent ? yield* workspaceRootFor(parent) : undefined);
      const providers = yield* providerRegistry.getProviders;
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const defaultModel = Option.isSome(settings)
        ? settings.value.helperModelSelection.model
        : "unknown";
      return [
        runLines.length > 0 ? runLines.join("\n") : "No helpers started from this thread yet.",
        "",
        "Profiles:",
        ...profiles.map(
          (profile) =>
            `- ${profile.name}${profile.readOnly ? " (read-only)" : ""}${profile.source === "project" ? " (project)" : ""}: ${profile.description}`,
        ),
        "",
        `Default model: ${defaultModel}. Usable models: ${listHelperModelNames(providers)}.`,
      ].join("\n");
    });

  const stop: HelperService["Service"]["stop"] = (threadId, id) =>
    Effect.gen(function* () {
      const wanted = id.trim();
      if (!wanted) return yield* reject("stop requires id (or all)");
      const own = [...runs.values()].filter(
        (run) => run.parentThreadId === threadId && run.status === "running",
      );
      const targets = wanted === "all" ? own : own.filter((run) => run.id === wanted);
      if (targets.length === 0) {
        return yield* reject(
          wanted === "all" ? "no helpers are running" : `no running helper with id ${wanted}`,
        );
      }
      for (const run of targets) yield* stopRun(run, "agent");
      return `Stopped ${targets.map((run) => `${run.id} "${run.name}"`).join(", ")}`;
    });

  const stopById: HelperService["Service"]["stopById"] = (id) =>
    Effect.gen(function* () {
      const run = runs.get(id);
      if (!run || run.status !== "running") return false;
      yield* stopRun(run, "user");
      return true;
    });

  const hasRunning: HelperService["Service"]["hasRunning"] = (threadId) =>
    Effect.sync(() =>
      [...runs.values()].some((run) => run.parentThreadId === threadId && run.status === "running"),
    );

  // --- background work -------------------------------------------------------

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.session-set":
      case "thread.turn-diff-completed":
      case "thread.deleted":
      case "thread.archived": {
        const threadId = event.payload.threadId;
        const run = runByThread.get(threadId);
        const orphans =
          event.type === "thread.deleted" || event.type === "thread.archived"
            ? [...runs.values()].filter(
                (entry) => entry.parentThreadId === threadId && entry.status === "running",
              )
            : [];
        return Effect.gen(function* () {
          if (run) yield* checkRun(run);
          for (const orphan of orphans) yield* stopRun(orphan, "parent");
        });
      }
      default:
        return Effect.void;
    }
  };

  const reportLostRuns = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) return;
    yield* fileSystem.remove(statePath, { force: true }).pipe(Effect.ignore);
    const lost = yield* decodePersistedRuns(raw.value).pipe(Effect.orElseSucceed(() => []));
    for (const entry of lost) {
      yield* wakeQueue.deliver({
        threadId: ThreadId.make(entry.parentThreadId),
        text: `[Helper "${entry.name}" failed · ${entry.model} · id ${entry.id}]\nT3 Code restarted before this helper finished. Its thread may show partial work. Check it, and start a new helper if the task still matters.`,
        source: "helper",
      });
    }
  });

  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(Stream.runForEach(events, onEvent));
  yield* forkParked(reportLostRuns);
  yield* forkParked(
    Effect.suspend(() =>
      Effect.forEach(
        [...runs.values()].filter((run) => run.status === "running"),
        checkRun,
        { discard: true },
      ),
    ).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
  );

  return HelperService.of({
    start,
    list,
    stop,
    stopById,
    hasRunning,
    streamChanges: SubscriptionRef.changes(changes),
  });
});

export const layer = Layer.effect(HelperService, make);
