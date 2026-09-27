import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadWakeQueue from "./ThreadWakeQueue.ts";

const THREAD = ThreadId.make("thread-1");
const STATE_FILE = "/t3/userdata/wake-queue.json";

const shell = {
  id: THREAD,
  projectId: ProjectId.make("project-1"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  latestTurn: null,
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as unknown as OrchestrationThreadShell;

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

const makeHarness = Effect.fn("makeWakeHarness")(function* (options: {
  readonly saved?: string;
  readonly busy?: boolean;
}) {
  const files = new Map<string, string>();
  if (options.saved) files.set(STATE_FILE, options.saved);
  const missing = FileSystem.makeNoop({});
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const busySession = {
    threadId: THREAD,
    status: "running" as const,
    providerName: null,
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const context = yield* Layer.build(
    ThreadWakeQueue.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () =>
              Effect.succeedSome(options.busy ? { ...shell, session: busySession } : shell),
          }),
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Ref.update(commands, (recorded) => [...recorded, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
            subscribeDomainEvents: Effect.succeed(Stream.never),
          }),
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir: "/t3/userdata",
          } as ServerConfig.ServerConfig["Service"]),
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: (file) => {
                const contents = files.get(file);
                return contents === undefined
                  ? missing.readFileString(file)
                  : Effect.succeed(contents);
              },
              writeFileString: (file, contents) =>
                Effect.sync(() => void files.set(file, contents)),
              remove: (file) => Effect.sync(() => void files.delete(file)),
            }),
          ),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(3),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
        ),
      ),
    ),
  );
  const queue = yield* ThreadWakeQueue.ThreadWakeQueue.pipe(Effect.provide(context));
  yield* settle;
  const sent = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.message.text] : [],
      ),
    ),
  );
  return { queue, sent, files };
});

describe("ThreadWakeQueue", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("saves waiting messages so a restart can still send them", () =>
      Effect.gen(function* () {
        const busy = yield* makeHarness({ busy: true });
        yield* busy.queue.deliver({ threadId: THREAD, text: "wake up", source: "defer" });
        expect(yield* busy.sent).toEqual([]);
        const saved = busy.files.get(STATE_FILE);
        expect(saved).toContain("wake up");

        const restarted = yield* makeHarness(saved ? { saved } : {});
        expect(yield* restarted.sent).toEqual(["wake up"]);
        expect(restarted.files.has(STATE_FILE)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
