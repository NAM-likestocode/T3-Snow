import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as SubagentControl from "./SubagentControl.ts";

const THREAD = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const shell = {
  id: THREAD,
  projectId: ProjectId.make("project-1"),
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
} as OrchestrationThreadShell;

const makeHarness = Effect.fn("makeSubagentControlHarness")(function* (
  adapter: Partial<ProviderAdapterShape<ProviderAdapterRequestError>>,
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderSessionDirectory)({
      getBinding: () =>
        Effect.succeedSome({
          threadId: THREAD,
          provider: "claudeAgent" as never,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          resumeCursor: { resume: "session-1" },
        }),
    }),
    Layer.mock(ProviderAdapterRegistry)({
      getByInstance: () =>
        Effect.succeed({ hasSession: () => Effect.succeed(true), ...adapter } as never),
    }),
    Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: () => Effect.succeedSome(shell) }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const control = yield* SubagentControl.SubagentControl.pipe(
    Effect.provide(
      Layer.effect(SubagentControl.SubagentControl, SubagentControl.make).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  return { control, commands };
});

describe("SubagentControl", () => {
  it.effect("stops a subagent through the adapter and explains when it cannot", () =>
    Effect.gen(function* () {
      const stopped = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        stopSubagent: (_threadId, taskId) => Ref.update(stopped, (ids) => [...ids, taskId]),
      });
      expect(yield* harness.control.stop({ threadId: THREAD, taskId: "agent-1" as never })).toEqual(
        {
          ok: true,
        },
      );
      expect(yield* Ref.get(stopped)).toEqual(["agent-1"]);

      const failing = yield* makeHarness({
        stopSubagent: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "turn/interrupt",
              detail: "That agent is not running a turn right now.",
            }),
          ),
      });
      expect(yield* failing.control.stop({ threadId: THREAD, taskId: "x" as never })).toEqual({
        ok: false,
        message: "That agent is not running a turn right now.",
      });

      const unsupported = yield* makeHarness({});
      expect((yield* unsupported.control.stop({ threadId: THREAD, taskId: "x" as never })).ok).toBe(
        false,
      );
    }),
  );

  it.effect("reads the transcript with the persisted resume cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        readSubagentTranscript: (input) =>
          Effect.succeed({
            entries: [
              { kind: "text", text: `cursor ${(input.resumeCursor as { resume: string }).resume}` },
            ],
            omitted: 0,
          }),
      });
      expect(yield* harness.control.transcript({ threadId: THREAD, taskId: "a" as never })).toEqual(
        {
          entries: [{ kind: "text", text: "cursor session-1" }],
          omitted: 0,
        },
      );
      const none = yield* makeHarness({});
      expect(yield* none.control.transcript({ threadId: THREAD, taskId: "a" as never })).toEqual({
        entries: null,
        omitted: 0,
      });
    }),
  );

  it.effect("sends a message to the main agent, addressed to the subagent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      expect(
        yield* harness.control.message({
          threadId: THREAD,
          taskId: "agent-1" as never,
          title: "Build web UI",
          text: "Use Tailwind" as never,
        }),
      ).toEqual({ ok: true });
      const [command] = yield* Ref.get(harness.commands);
      expect(command).toMatchObject({ type: "thread.turn.start", runtimeMode: "full-access" });
      expect(command?.type === "thread.turn.start" && command.message.text).toContain(
        'Message from the user for your subagent "Build web UI" (id agent-1):\n\nUse Tailwind',
      );
    }),
  );
});
