import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AutopilotSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
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
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
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

function makeShell(overrides: Partial<OrchestrationThreadShell> = {}) {
  return {
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as OrchestrationThreadShell;
}

const runningSession = {
  threadId: THREAD,
  status: "running" as const,
  providerName: null,
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
};

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

const makeHarness = Effect.fn("makeAutopilotHarness")(function* (
  options: { readonly shell?: Partial<OrchestrationThreadShell>; readonly persisted?: string } = {},
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
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const deferArmed = yield* Ref.make(false);

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Ref.get(shell).pipe(Effect.asSome),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    }),
    Layer.mock(DeferService.DeferService)({ hasArmed: () => Ref.get(deferArmed) }),
    ThreadTurnPreamble.layer,
    Layer.succeed(ServerConfig.ServerConfig, { stateDir } as ServerConfig.ServerConfig["Service"]),
    Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const context = yield* Layer.build(
    Layer.effect(AutopilotService.AutopilotService, AutopilotService.make).pipe(
      Layer.provideMerge(ThreadWakeQueue.layer),
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

  const ofType = <T extends OrchestrationCommand["type"]>(type: T) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) =>
        recorded.filter(
          (command): command is Extract<OrchestrationCommand, { type: T }> => command.type === type,
        ),
      ),
    );
  const activities = ofType("thread.activity.append").pipe(
    Effect.map((recorded) => recorded.map((command) => command.activity.summary)),
  );
  const publish = (event: unknown) =>
    PubSub.publish(events, event as OrchestrationEvent).pipe(Effect.andThen(settle));
  const turnEnded = Effect.gen(function* () {
    yield* Ref.update(shell, (current) => ({
      ...current,
      session: null,
      latestTurn: completedTurn,
    }));
    yield* publish({
      type: "thread.session-set",
      payload: { threadId: THREAD, session: { threadId: THREAD, status: "ready" } },
    });
  });
  return {
    autopilot,
    preamble,
    shell,
    latest,
    ofType,
    activities,
    publish,
    turnEnded,
    deferArmed,
    files,
  };
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
        yield* Ref.update(harness.shell, (shell) => ({ ...shell, session: runningSession }));
        expect(yield* harness.autopilot.start(THREAD, "ship it")).toEqual({
          started: false,
          message: "Autopilot can start only when no other agent work is active or queued.",
        });
        yield* Ref.update(harness.shell, (shell) => ({
          ...shell,
          session: null,
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
        const [goalTurn] = yield* harness.ofType("thread.turn.start");
        expect(goalTurn).toMatchObject({
          message: { text: "Autopilot end goal:\n\nAdd dark mode" },
          interactionMode: "default",
          runtimeMode: "full-access",
        });
        const text = yield* harness.preamble.apply(THREAD, "user text");
        expect(text).toMatch(/^## Autopilot mode\n/);
        expect(text).toContain("<autopilot-goal>\nAdd dark mode\n</autopilot-goal>");
        expect(text).toMatch(/\n---\n\nuser text$/);
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([
          { threadId: THREAD, goal: "Add dark mode", status: "active" },
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("turns itself off only once wake-ups are done too", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        yield* harness.turnEnded;
        expect((yield* Ref.get(harness.latest)).threads).toHaveLength(1);

        yield* Ref.set(harness.deferArmed, false);
        yield* harness.turnEnded;
        expect((yield* Ref.get(harness.latest)).threads).toEqual([]);
        expect(yield* harness.activities).toEqual(["Autopilot on", "Autopilot finished"]);
        expect(yield* harness.preamble.apply(THREAD, "after")).toBe("after");
        expect(harness.files.size).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect("answers the agent's questions itself while on", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* harness.publish({
          type: "thread.activity-appended",
          payload: {
            threadId: THREAD,
            activity: {
              kind: "user-input.requested",
              payload: {
                requestId: "req-1",
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
            },
          },
        });
        expect(yield* harness.ofType("thread.user-input.respond")).toMatchObject([
          { requestId: "req-1", answers: { "Which theme?": AUTOPILOT_QUESTION_ANSWER, q2: "a" } },
        ]);
        expect(yield* harness.activities).toContain(
          "Autopilot answered a question itself: Which theme?",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("stops and interrupts the running turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.update(harness.shell, (shell) => ({ ...shell, session: runningSession }));
        expect(yield* harness.autopilot.stop(THREAD)).toBe(true);
        expect(yield* harness.ofType("thread.turn.interrupt")).toHaveLength(1);
        expect(yield* harness.autopilot.stop(THREAD)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("pauses once the turn budget is used up", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        const turnSeen = (index: number) =>
          Ref.update(harness.shell, (shell) => ({
            ...shell,
            latestTurn: { ...completedTurn, turnId: TurnId.make(`turn-${index}`) },
          })).pipe(
            Effect.andThen(
              harness.publish({ type: "thread.session-set", payload: { threadId: THREAD } }),
            ),
          );
        for (let index = 1; index <= AutopilotService.AUTOPILOT_MAX_TURNS; index += 1) {
          yield* turnSeen(index);
        }
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "active" }]);

        yield* turnSeen(AutopilotService.AUTOPILOT_MAX_TURNS + 1);
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "paused" }]);
        expect((yield* harness.activities).at(-1)).toMatch(/^Autopilot paused: budget reached/);
        expect(yield* harness.preamble.apply(THREAD, "x")).toBe("x");

        // Resuming starts a fresh budget.
        expect(yield* harness.autopilot.resume(THREAD)).toBe(true);
        yield* turnSeen(AutopilotService.AUTOPILOT_MAX_TURNS + 2);
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "active" }]);
      }).pipe(Effect.scoped),
    );

    it.effect("pauses once the time budget is used up", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.autopilot.start(THREAD, "Add dark mode");
        yield* Ref.set(harness.deferArmed, true);
        yield* TestClock.adjust(AutopilotService.AUTOPILOT_MAX_DURATION_MS);
        yield* harness.turnEnded;
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "paused" }]);
      }).pipe(Effect.scoped),
    );

    it.effect("comes back paused after a restart and resumes on request", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          persisted: `[{"threadId":"${THREAD}","goal":"Add dark mode","startedAt":"${NOW}"}]`,
          shell: { latestTurn: completedTurn },
        });
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "paused" }]);
        expect(yield* harness.preamble.apply(THREAD, "x")).toBe("x");

        expect(yield* harness.autopilot.resume(THREAD)).toBe(true);
        yield* harness.publish({ type: "noop" });
        expect((yield* Ref.get(harness.latest)).threads).toMatchObject([{ status: "active" }]);
        const [resumeTurn] = yield* harness.ofType("thread.turn.start");
        expect(resumeTurn?.message.text).toContain("Autopilot resumed");
      }).pipe(Effect.scoped),
    );
  });
});
