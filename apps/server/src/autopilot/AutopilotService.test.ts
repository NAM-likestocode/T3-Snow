import {
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type AutopilotSnapshot,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DeferService from "../defer/DeferService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
import * as AutopilotService from "./AutopilotService.ts";
import { AUTOPILOT_QUESTION_ANSWER } from "./autopilotFormat.ts";

const THREAD = ThreadId.make("thread-1");
const NOW = "1970-01-01T00:00:00.000Z";

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    uuidCounter += 1;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (uuidCounter * 7 + index) % 256;
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

/** The shell fields the service reads; the rest of the shell is irrelevant here. */
function makeShell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    runtimeMode: "full-access",
    activeRunId: null,
    latestRunId: null,
    latestRunRequestedAt: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

const makeHarness = Effect.fn("makeAutopilotHarness")(function* (
  options: {
    readonly shell?: Partial<OrchestrationV2ThreadShell>;
    readonly persisted?: string;
  } = {},
) {
  const path = yield* Path.Path;
  const stateDir = "/t3/userdata";
  const files = new Map<string, string>();
  if (options.persisted !== undefined) {
    files.set(path.join(stateDir, "autopilot.json"), options.persisted);
  }
  const missing = FileSystem.makeNoop({});
  const memoryFileSystem = FileSystem.makeNoop({
    readFileString: (file) => {
      const contents = files.get(file);
      return contents === undefined ? missing.readFileString(file) : Effect.succeed(contents);
    },
    writeFileString: (file, contents) => Effect.sync(() => void files.set(file, contents)),
    remove: (file) => Effect.sync(() => void files.delete(file)),
  });

  const shell = yield* Ref.make(makeShell(options.shell));
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const deferArmed = yield* Ref.make(false);

  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () => Ref.get(shell),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
      streamDomainEvents: Stream.fromPubSub(events),
    }),
    Layer.mock(DeferService.DeferService)({ hasArmed: () => Ref.get(deferArmed) }),
    ThreadTurnPreamble.layer,
    Layer.succeed(ServerConfig.ServerConfig, { stateDir } as ServerConfig.ServerConfig["Service"]),
    Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const context = yield* Layer.build(
    Layer.effect(AutopilotService.AutopilotService, AutopilotService.make).pipe(
      Layer.provideMerge(dependencies),
    ),
  );
  const autopilot = yield* AutopilotService.AutopilotService.pipe(Effect.provide(context));
  const preamble = yield* ThreadTurnPreamble.ThreadTurnPreamble.pipe(Effect.provide(context));
  yield* settle;

  const latest = yield* Ref.make<AutopilotSnapshot>({ threads: [] });
  yield* autopilot.streamChanges.pipe(
    Stream.runForEach((snapshot) => Ref.set(latest, snapshot)),
    Effect.forkScoped,
  );
  yield* settle;

  const ofType = <T extends OrchestrationV2ServerCommand["type"]>(type: T) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) =>
        recorded.filter(
          (command): command is Extract<OrchestrationV2ServerCommand, { type: T }> =>
            command.type === type,
        ),
      ),
    );
  const publish = (event: unknown) =>
    PubSub.publish(events, event as OrchestrationV2DomainEvent).pipe(Effect.andThen(settle));
  let runCounter = 0;
  /** A run is requested now and has already ended. */
  const runEnded = Effect.gen(function* () {
    runCounter += 1;
    const runId = RunId.make(`run-${runCounter}`);
    const requestedAt = yield* DateTime.now;
    yield* Ref.update(shell, (current) => ({
      ...current,
      activeRunId: null,
      latestRunId: runId,
      latestRunRequestedAt: requestedAt,
    }));
    yield* publish({ type: "run.created", threadId: THREAD, payload: { id: runId } });
    yield* publish({ type: "run.updated", threadId: THREAD, payload: { id: runId } });
  });
  const status = Ref.get(latest).pipe(Effect.map((snapshot) => snapshot.threads[0]?.status));
  return { autopilot, preamble, shell, ofType, publish, runEnded, status, deferArmed, files };
});

describe("AutopilotService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("refuses an empty goal or a busy thread, and warns about approval prompts", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.autopilot.start(THREAD, ' "" ')).toEqual({
          started: false,
          message: "Usage: /autopilot <end goal>",
        });
        yield* Ref.update(harness.shell, (shell) => ({ ...shell, activeRunId: RunId.make("r") }));
        expect(yield* harness.autopilot.start(THREAD, "ship it")).toEqual({
          started: false,
          message: "Autopilot can start only when no other agent work is active or queued.",
        });
        yield* Ref.update(harness.shell, (shell) => ({
          ...shell,
          activeRunId: null,
          runtimeMode: "approval-required" as const,
        }));
        expect(yield* harness.autopilot.start(THREAD, "ship it")).toMatchObject({
          started: true,
          message: expect.stringContaining("approval prompts"),
        });
      }).pipe(Effect.scoped),
    );

    it.effect("sends the goal and puts the Autopilot block before every turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.autopilot.start(THREAD, '"Add dark mode"')).toEqual({
          started: true,
        });
        expect(yield* harness.ofType("message.dispatch")).toMatchObject([
          {
            threadId: THREAD,
            text: "Autopilot end goal:\n\nAdd dark mode",
            dispatchMode: { type: "queue_after_active" },
          },
        ]);
        const text = yield* harness.preamble.apply(THREAD, "user text");
        expect(text).toMatch(/^## Autopilot mode\n/);
        expect(text).toContain("<autopilot-goal>\nAdd dark mode\n</autopilot-goal>");
        expect(text).toMatch(/\n---\n\nuser text$/);
        expect(yield* harness.status).toBe("active");
      }).pipe(Effect.scoped),
    );

    it.effect("turns itself off only once wake-ups are done too", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        yield* harness.runEnded;
        expect(yield* harness.status).toBe("active");

        yield* Ref.set(harness.deferArmed, false);
        yield* harness.runEnded;
        expect(yield* harness.status).toBeUndefined();
        expect(yield* harness.preamble.apply(THREAD, "after")).toBe("after");
        expect(harness.files.size).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect("answers the agent's questions itself, once each", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        const question = {
          type: "turn-item.updated",
          threadId: THREAD,
          payload: {
            type: "user_input_request",
            status: "waiting",
            requestId: RuntimeRequestId.make("req-1"),
            questions: [
              {
                id: "Which theme?",
                header: "Theme",
                question: "Which theme?",
                options: [{ label: "Dark", description: "dark" }],
              },
              {
                id: "q2",
                header: "Pick",
                question: "Pick one",
                options: [{ label: "A", description: "a", value: "a" }],
                allowCustomAnswer: false,
              },
            ],
          },
        };
        yield* harness.publish(question);
        yield* harness.publish(question);
        expect(yield* harness.ofType("runtime-request.respond")).toMatchObject([
          { requestId: "req-1", answers: { "Which theme?": AUTOPILOT_QUESTION_ANSWER, q2: "a" } },
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("stops and interrupts the running turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.update(harness.shell, (shell) => ({ ...shell, activeRunId: RunId.make("r") }));
        expect(yield* harness.autopilot.stop(THREAD)).toBe(true);
        expect(yield* harness.ofType("run.interrupt")).toMatchObject([{ runId: "r" }]);
        expect(yield* harness.autopilot.stop(THREAD)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("comes back paused after a restart and resumes on request", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          persisted: `[{"threadId":"${THREAD}","goal":"Add dark mode","startedAt":"${NOW}"}]`,
        });
        expect(yield* harness.status).toBe("paused");
        expect(yield* harness.preamble.apply(THREAD, "x")).toBe("x");

        expect(yield* harness.autopilot.resume(THREAD)).toBe(true);
        expect(yield* harness.status).toBe("active");
        const [resumeMessage] = yield* harness.ofType("message.dispatch");
        expect(resumeMessage?.text).toContain("Autopilot resumed");
      }).pipe(Effect.scoped),
    );

    it.effect("pauses once the turn budget is used up, and Resume starts a fresh one", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        for (let index = 0; index < AutopilotService.AUTOPILOT_MAX_TURNS; index += 1) {
          yield* harness.runEnded;
        }
        expect(yield* harness.status).toBe("active");

        yield* harness.runEnded;
        expect(yield* harness.status).toBe("paused");
        expect(yield* harness.preamble.apply(THREAD, "x")).toBe("x");

        expect(yield* harness.autopilot.resume(THREAD)).toBe(true);
        yield* harness.runEnded;
        expect(yield* harness.status).toBe("active");
      }).pipe(Effect.scoped),
    );

    it.effect("pauses once the time budget is used up", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        yield* TestClock.adjust(AutopilotService.AUTOPILOT_MAX_DURATION_MS);
        yield* harness.runEnded;
        expect(yield* harness.status).toBe("paused");
      }).pipe(Effect.scoped),
    );
  });
});
