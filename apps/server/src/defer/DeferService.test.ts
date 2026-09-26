import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import * as DeferService from "./DeferService.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    uuidCounter += 1;
    return new Uint8Array(size).fill(uuidCounter % 256);
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace/project",
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function sessionSet(status: string): OrchestrationEvent {
  return {
    type: "thread.session-set",
    payload: { threadId: THREAD_ID, session: { threadId: THREAD_ID, status } },
  } as unknown as OrchestrationEvent;
}

interface HarnessOptions {
  readonly runtimeMode?: RuntimeMode;
  /** Exit codes returned by successive shell runs; the last one repeats. */
  readonly exitCodes?: ReadonlyArray<number>;
  readonly persisted?: string;
}

const makeHarness = Effect.fn("makeDeferHarness")(function* (options: HarnessOptions = {}) {
  const path = yield* Path.Path;
  const stateDir = "/t3/userdata";
  // In memory, so every step the service takes is under the test's control.
  const files = new Map<string, string>();
  if (options.persisted !== undefined) {
    files.set(path.join(stateDir, "defer-triggers.json"), options.persisted);
  }
  const missing = FileSystem.makeNoop({});
  const memoryFileSystem = FileSystem.makeNoop({
    exists: (file) => Effect.succeed(files.has(file)),
    readFileString: (file) => {
      const contents = files.get(file);
      return contents === undefined ? missing.readFileString(file) : Effect.succeed(contents);
    },
    writeFileString: (file, contents) => Effect.sync(() => void files.set(file, contents)),
    remove: (file) => Effect.sync(() => void files.delete(file)),
  });

  const thread = yield* Ref.make(makeThread({ runtimeMode: options.runtimeMode ?? "full-access" }));
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const runs = yield* Ref.make<ReadonlyArray<string>>([]);
  const exitCodes = options.exitCodes ?? [0];

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Ref.get(thread).pipe(Effect.asSome),
      getProjectShellById: () => Effect.succeedNone,
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    }),
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Ref.modify(runs, (recorded) => [
          recorded.length,
          [...recorded, input.args.at(-1) ?? ""],
        ]).pipe(
          Effect.map((index) => ({
            stdout: `run ${index + 1}`,
            stderr: "",
            code: (exitCodes[Math.min(index, exitCodes.length - 1)] ?? 0) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          })),
        ),
    }),
    // The service only reads stateDir.
    Layer.succeed(ServerConfig.ServerConfig, { stateDir } as ServerConfig.ServerConfig["Service"]),
    Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const service = yield* Layer.build(
    Layer.effect(DeferService.DeferService, DeferService.make).pipe(
      Layer.provideMerge(ThreadWakeQueue.layer),
      Layer.provide(dependencies),
    ),
  ).pipe(Effect.map((context) => context.pipe((ctx) => ctx)));
  const defer = yield* DeferService.DeferService.pipe(Effect.provide(service));
  // Let the background subscribers start.
  yield* settle;

  const turnStarts = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.message.text] : [],
      ),
    ),
  );
  // Step the clock a second at a time so every poll loop sees each moment pass.
  const advance = (duration: `${number} ${"seconds" | "minutes"}`) => {
    const [amount, unit] = duration.split(" ");
    const seconds = Number(amount) * (unit === "minutes" ? 60 : 1);
    return TestClock.adjust("1 second").pipe(
      Effect.andThen(settle),
      Effect.repeat({ times: seconds - 1 }),
    );
  };
  return { defer, thread, events, runs, turnStarts, advance, stateDir };
});

/** Lets forked trigger and delivery fibers run to their next suspension point. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

const armedId = (confirmation: string) => /^Armed (d[a-z0-9]{5})/.exec(confirmation)?.[1] ?? "";

describe("DeferService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("fires a time trigger once, as a message in the thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const confirmation = yield* harness.defer.create({
          threadId: THREAD_ID,
          note: "check the deploy",
          at: "in 30m",
        });
        const id = armedId(confirmation);
        expect(confirmation).toMatch(/^Armed d[a-z0-9]{5} at /);

        yield* harness.advance("29 minutes");
        expect(yield* harness.turnStarts).toEqual([]);
        yield* harness.advance("1 minutes");
        expect(yield* harness.turnStarts).toEqual([
          `${id} fired: scheduled time reached\ncheck the deploy`,
        ]);
        expect(yield* harness.defer.list(THREAD_ID)).toBe("No deferred triggers armed.");
      }).pipe(Effect.scoped),
    );

    it.effect("waits for a running turn to finish instead of interrupting it", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Ref.update(harness.thread, (thread) => ({
          ...thread,
          session: {
            threadId: THREAD_ID,
            status: "running" as const,
            providerName: null,
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        }));
        yield* harness.defer.create({ threadId: THREAD_ID, note: "later", at: "in 1m" });
        yield* harness.advance("1 minutes");
        expect(yield* harness.turnStarts).toEqual([]);

        yield* Ref.update(harness.thread, (thread) => ({ ...thread, session: null }));
        yield* PubSub.publish(harness.events, sessionSet("ready"));
        yield* settle;
        expect(yield* harness.turnStarts).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("fires a condition trigger as soon as its check exits 0, attaching run output", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ exitCodes: [1, 0, 0] });
        const confirmation = yield* harness.defer.create({
          threadId: THREAD_ID,
          note: "tests finished",
          check: "test -f done",
          run: "tail test.log",
        });
        const id = armedId(confirmation);
        expect(confirmation).toBe(`Armed ${id} when \`test -f done\`, runs \`tail test.log\``);

        yield* harness.advance("1 seconds");
        expect(yield* harness.turnStarts).toEqual([]);
        yield* harness.advance("15 seconds");
        expect(yield* harness.turnStarts).toEqual([
          `${id} fired: \`test -f done\` held after 16s\ntests finished\n\n$ tail test.log (exit 0)\nrun 3`,
        ]);
        expect(yield* Ref.get(harness.runs)).toEqual([
          "test -f done",
          "test -f done",
          "tail test.log",
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("always fires a condition trigger at its deadline, saying it gave up", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ exitCodes: [1] });
        const id = armedId(
          yield* harness.defer.create({
            threadId: THREAD_ID,
            note: "review CI",
            check: "false",
            timeoutMs: 60_000,
          }),
        );
        yield* harness.advance("1 minutes");
        const [message] = yield* harness.turnStarts;
        expect(message).toMatch(
          new RegExp(`^${id} fired: gave up after 1m, \\d+ checks, last exit 1\\nreview CI$`),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("treats at as the deadline of a condition trigger", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ exitCodes: [1] });
        yield* harness.defer.create({
          threadId: THREAD_ID,
          note: "subagent check-in",
          check: "false",
          at: "in 10m",
        });
        yield* harness.advance("9 minutes");
        expect(yield* harness.turnStarts).toEqual([]);
        yield* harness.advance("1 minutes");
        expect((yield* harness.turnStarts)[0]).toContain("gave up after 10m");
      }).pipe(Effect.scoped),
    );

    it.effect("cancels a trigger so it never fires", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const id = armedId(
          yield* harness.defer.create({ threadId: THREAD_ID, note: "nope", at: "in 5m" }),
        );
        expect(yield* harness.defer.cancel(THREAD_ID, id)).toBe(`Cancelled ${id} — nope`);
        yield* harness.advance("5 minutes");
        expect(yield* harness.turnStarts).toEqual([]);
        const error = yield* harness.defer.cancel(THREAD_ID, id).pipe(Effect.flip);
        expect(error.message).toBe(`no armed trigger with id ${id}`);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps each thread's triggers private to that thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const id = armedId(
          yield* harness.defer.create({ threadId: THREAD_ID, note: "mine", at: "in 5m" }),
        );
        const otherThread = ThreadId.make("thread-2");
        const error = yield* harness.defer.cancel(otherThread, id).pipe(Effect.flip);
        expect(error.message).toBe(`no armed trigger with id ${id}`);
        expect(yield* harness.defer.list(otherThread)).toBe("No deferred triggers armed.");
        expect(yield* harness.defer.list(THREAD_ID)).toContain(`${id} — mine`);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects invalid requests with Pi's messages", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const message = (input: Omit<DeferService.DeferCreateInput, "threadId">) =>
          harness.defer.create({ threadId: THREAD_ID, ...input }).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        expect(yield* message({ at: "in 1m" })).toBe("create requires a note");
        expect(yield* message({ note: "x" })).toBe("create requires at, check, or run");
        expect(yield* message({ note: "x", run: "ls" })).toBe(
          "`run` needs `at` or `check` to say when it fires — to run something now, use bash",
        );
        expect(yield* message({ note: "x", at: "tomorrow 9am" })).toBe(
          "could not understand time: tomorrow 9am",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("allows ten armed triggers per thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        for (let index = 0; index < 10; index += 1) {
          yield* harness.defer.create({ threadId: THREAD_ID, note: `n${index}`, at: "in 1h" });
        }
        const error = yield* harness.defer
          .create({ threadId: THREAD_ID, note: "one too many", at: "in 1h" })
          .pipe(Effect.flip);
        expect(error.message).toContain("already has 10 armed triggers");
      }).pipe(Effect.scoped),
    );

    it.effect("only runs commands for threads in full access or auto mode", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ runtimeMode: "approval-required" });
        const error = yield* harness.defer
          .create({ threadId: THREAD_ID, note: "x", check: "true" })
          .pipe(Effect.flip);
        expect(error.message).toContain("Full access or Auto mode");
        expect(
          yield* harness.defer.create({ threadId: THREAD_ID, note: "x", at: "in 1m" }),
        ).toMatch(/^Armed /);
      }).pipe(Effect.scoped),
    );

    it.effect("reports triggers lost to a restart instead of dropping them", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          persisted: `[{"id":"dabc12","threadId":"${THREAD_ID}","note":"check the build"}]`,
        });
        yield* settle;
        expect(yield* harness.turnStarts).toEqual([
          "dabc12 lost: T3 Code restarted before it fired\ncheck the build\n\nCheck on it yourself and arm a new trigger if it is still needed.",
        ]);
      }).pipe(Effect.scoped),
    );
  });
});
