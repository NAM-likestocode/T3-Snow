import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import * as HelperService from "./HelperService.ts";

const PARENT = ThreadId.make("parent-1");
const OTHER = ThreadId.make("other-1");
const PROJECT_ID = ProjectId.make("project-1");
const NOW = "2026-09-01T00:00:00.000Z";

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

function makeShell(id: ThreadId, overrides: Partial<OrchestrationThreadShell> = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: "feature/x",
    worktreePath: "/workspace/project",
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

const running = {
  threadId: PARENT,
  status: "running" as const,
  providerName: null,
  runtimeMode: "auto" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
};

function provider(instanceId: string, models: ReadonlyArray<string>, authed = true) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: authed ? "authenticated" : "unauthenticated" },
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: instanceId === "codex" ? "reasoningEffort" : "effort",
            label: "Effort",
            type: "select",
            options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
  } as unknown as ServerProvider;
}

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

const makeHarness = Effect.fn("makeHelperHarness")(function* (
  options: { readonly claudeAuthed?: boolean; readonly persisted?: string } = {},
) {
  const path = yield* Path.Path;
  const stateDir = "/t3/userdata";
  const files = new Map<string, string>();
  if (options.persisted !== undefined) {
    files.set(path.join(stateDir, "helper-runs.json"), options.persisted);
  }
  const missing = FileSystem.makeNoop({});
  const memoryFileSystem = FileSystem.makeNoop({
    exists: (file) => Effect.succeed(files.has(file)),
    readDirectory: (directory) => missing.readDirectory(directory),
    readFileString: (file) => {
      const contents = files.get(file);
      return contents === undefined ? missing.readFileString(file) : Effect.succeed(contents);
    },
    writeFileString: (file, contents) => Effect.sync(() => void files.set(file, contents)),
    remove: (file) => Effect.sync(() => void files.delete(file)),
  });

  const shells = yield* Ref.make(
    new Map<ThreadId, OrchestrationThreadShell>([
      [PARENT, makeShell(PARENT)],
      [OTHER, makeShell(OTHER)],
    ]),
  );
  const reports = yield* Ref.make(new Map<ThreadId, string>());
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(shells).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
      getThreadDetailById: (threadId) =>
        Effect.all([Ref.get(shells), Ref.get(reports)]).pipe(
          Effect.map(([map, texts]) => {
            const shell = map.get(threadId);
            if (!shell) return Option.none();
            const text = texts.get(threadId);
            return Option.some({
              ...shell,
              messages:
                text === undefined
                  ? []
                  : [
                      {
                        id: "m1",
                        role: "assistant",
                        text,
                        turnId: shell.latestTurn?.turnId ?? null,
                        streaming: false,
                        createdAt: NOW,
                        updatedAt: NOW,
                      },
                    ],
              proposedPlans: [],
              activities: [{ kind: "tool.completed" }, { kind: "tool.completed" }],
            } as unknown as OrchestrationThread);
          }),
        ),
      getProjectShellById: () => Effect.succeedNone,
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (recorded) => [...recorded, command]);
          if (command.type === "thread.create") {
            yield* Ref.update(shells, (map) =>
              new Map(map).set(
                command.threadId,
                makeShell(command.threadId, {
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                  worktreePath: command.worktreePath,
                  branch: command.branch,
                }),
              ),
            );
          }
          return { sequence: 1 };
        }),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([
        provider("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5"], options.claudeAuthed),
        provider("codex", ["gpt-6-astra"]),
      ]),
    }),
    ServerSettings.layerTest(),
    Layer.succeed(ServerConfig.ServerConfig, {
      stateDir,
      baseDir: "/t3",
    } as ServerConfig.ServerConfig["Service"]),
    Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const context = yield* Layer.build(
    Layer.effect(HelperService.HelperService, HelperService.make).pipe(
      Layer.provideMerge(ThreadWakeQueue.layer),
      Layer.provide(dependencies),
    ),
  );
  const helpers = yield* HelperService.HelperService.pipe(Effect.provide(context));
  yield* settle;

  const created = Ref.get(commands).pipe(
    Effect.map((recorded) => recorded.filter((command) => command.type === "thread.create")),
  );
  const turnStartsFor = (threadId: ThreadId) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) =>
        recorded.flatMap((command) =>
          command.type === "thread.turn.start" && command.threadId === threadId
            ? [command.message.text]
            : [],
        ),
      ),
    );
  const setShell = (threadId: ThreadId, patch: Partial<OrchestrationThreadShell>) =>
    Ref.update(shells, (map) => new Map(map).set(threadId, { ...map.get(threadId)!, ...patch }));
  /** Finishes the helper's turn with a report and tells the service. */
  const completeChild = (threadId: ThreadId, report: string) =>
    Effect.gen(function* () {
      yield* Ref.update(reports, (map) => new Map(map).set(threadId, report));
      yield* setShell(threadId, {
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      } as Partial<OrchestrationThreadShell>);
      yield* PubSub.publish(events, {
        type: "thread.session-set",
        payload: { threadId, session: { threadId, status: "ready" } },
      } as unknown as OrchestrationEvent);
      yield* settle;
    });
  return { helpers, created, turnStartsFor, setShell, completeChild, events, files, stateDir };
});

const startedId = (message: string) => /id (h[a-z0-9]{5})\./.exec(message)?.[1] ?? "";

describe("HelperService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("runs a helper on the helper model in the parent's checkout", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const message = yield* harness.helpers.start({
          threadId: PARENT,
          task: "Map the auth module",
          name: "auth map",
        });
        expect(message).toMatch(
          /^Started helper "auth map" \(worker; claude-opus-5-5:medium\) in the background, id h[a-z0-9]{5}\. /,
        );
        const [create] = yield* harness.created;
        expect(create).toMatchObject({
          title: "↳ auth map",
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "medium" }],
          },
          runtimeMode: "auto",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace/project",
        });
        const [task] = yield* harness.turnStartsFor(create!.threadId);
        expect(task).toContain("<task>\nMap the auth module\n</task>");
      }).pipe(Effect.scoped),
    );

    it.effect("delivers the report to the parent once it is idle, never mid-turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.helpers.start({ threadId: PARENT, task: "Review it", agent: "reviewer" });
        const [create] = yield* harness.created;
        expect(create).toMatchObject({ interactionMode: "plan" });

        yield* harness.setShell(PARENT, { session: running });
        yield* harness.completeChild(create!.threadId, "## Verdict\nship");
        expect(yield* harness.turnStartsFor(PARENT)).toEqual([]);

        yield* harness.setShell(PARENT, { session: null });
        yield* PubSub.publish(harness.events, {
          type: "thread.session-set",
          payload: { threadId: PARENT, session: { threadId: PARENT, status: "ready" } },
        } as unknown as OrchestrationEvent);
        yield* settle;
        const [report] = yield* harness.turnStartsFor(PARENT);
        expect(report).toMatch(
          /^\[Helper "reviewer" completed in 0s · 2 tool calls · claude-opus-5-5:medium · id h[a-z0-9]{5}\]\n## Verdict\nship\n\nTreat this as evidence/,
        );
        expect(yield* harness.helpers.hasRunning(PARENT)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("returns the report from a wait call, or falls back to background after 50s", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const quick = yield* harness.helpers
          .start({ threadId: PARENT, task: "Quick one", mode: "wait", model: "gpt6astra" })
          .pipe(Effect.forkChild);
        yield* settle;
        const [first] = yield* harness.created;
        expect(first).toMatchObject({ modelSelection: { instanceId: "codex" } });
        yield* harness.completeChild(first!.threadId, "done quickly");
        expect(yield* Fiber.join(quick)).toMatch(/^\[Helper .* completed .*\]\ndone quickly/);
        expect(yield* harness.turnStartsFor(PARENT)).toEqual([]);

        const slow = yield* harness.helpers
          .start({ threadId: PARENT, task: "Slow one", mode: "wait" })
          .pipe(Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust("50 seconds");
        expect(yield* Fiber.join(slow)).toMatch(/still running\.\)$/);
        const second = (yield* harness.created)[1]!;
        yield* harness.completeChild(second.threadId, "done slowly");
        expect(yield* harness.turnStartsFor(PARENT)).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses unusable models, too many helpers, and nesting past two levels", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ claudeAuthed: false });
        const unusable = yield* harness.helpers
          .start({ threadId: PARENT, task: "x" })
          .pipe(Effect.flip);
        expect(unusable.detail).toContain("is not usable");
        expect(unusable.detail).toContain("usable: gpt-6-astra");
        const unknown = yield* harness.helpers
          .start({ threadId: PARENT, task: "x", model: "mystery" })
          .pipe(Effect.flip);
        expect(unknown.detail).toBe('No usable model matches "mystery". Usable: gpt-6-astra.');

        yield* harness.helpers.start({ threadId: PARENT, task: "level 1", model: "gpt-6-astra" });
        const level1 = (yield* harness.created)[0]!.threadId;
        yield* harness.helpers.start({ threadId: level1, task: "level 2", model: "gpt-6-astra" });
        const level2 = (yield* harness.created)[1]!.threadId;
        const tooDeep = yield* harness.helpers
          .start({ threadId: level2, task: "level 3", model: "gpt-6-astra" })
          .pipe(Effect.flip);
        expect(tooDeep.detail).toContain("2 levels deep");

        yield* harness.helpers.start({ threadId: PARENT, task: "three", model: "gpt-6-astra" });
        yield* harness.helpers.start({ threadId: OTHER, task: "four", model: "gpt-6-astra" });
        const fifth = yield* harness.helpers
          .start({ threadId: PARENT, task: "five", model: "gpt-6-astra" })
          .pipe(Effect.flip);
        expect(fifth.detail).toContain("4 helpers are already running");
      }).pipe(Effect.scoped),
    );

    it.effect("lets a thread stop only its own helpers; a user stop is reported", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const id = startedId(yield* harness.helpers.start({ threadId: PARENT, task: "work" }));
        const denied = yield* harness.helpers.stop(OTHER, id).pipe(Effect.flip);
        expect(denied.detail).toBe(`no running helper with id ${id}`);

        expect(yield* harness.helpers.stopById(id)).toBe(true);
        yield* settle;
        const [report] = yield* harness.turnStartsFor(PARENT);
        expect(report).toMatch(/^\[Helper "worker" stopped in 0s/);
        expect(report).toContain("The user stopped this helper");
        expect(yield* harness.helpers.stopById(id)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("stops a deleted parent's helpers without reporting", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.helpers.start({ threadId: PARENT, task: "work" });
        yield* PubSub.publish(harness.events, {
          type: "thread.deleted",
          payload: { threadId: PARENT },
        } as unknown as OrchestrationEvent);
        yield* settle;
        expect(yield* harness.helpers.hasRunning(PARENT)).toBe(false);
        expect(yield* harness.turnStartsFor(PARENT)).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports helpers that were running when T3 Code restarted", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          persisted: `[{"id":"habcde","parentThreadId":"${PARENT}","threadId":"child-1","name":"scan","model":"claude-opus-5-5:medium"}]`,
        });
        expect(yield* harness.turnStartsFor(PARENT)).toEqual([
          '[Helper "scan" failed · claude-opus-5-5:medium · id habcde]\nT3 Code restarted before this helper finished. Its thread may show partial work. Check it, and start a new helper if the task still matters.',
        ]);
        expect(harness.files.size).toBe(0);
      }).pipe(Effect.scoped),
    );
  });
});
