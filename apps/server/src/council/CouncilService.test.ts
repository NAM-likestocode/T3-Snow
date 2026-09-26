import {
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type CouncilSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
import * as CouncilService from "./CouncilService.ts";

const THREAD = ThreadId.make("thread-1");
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

const shell = {
  id: THREAD,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
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
} as OrchestrationThreadShell;

function provider(instanceId: string, models: ReadonlyArray<string>) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
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
            options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
  } as unknown as ServerProvider;
}

type Runner = NonNullable<TextGeneration.TextGeneration["Service"]["runIsolatedPrompt"]>;

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 200 }));

const makeHarness = Effect.fn("makeCouncilHarness")(function* (runner: Runner) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const calls = yield* Ref.make<ReadonlyArray<TextGeneration.IsolatedPromptInput>>([]);

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeedSome(shell),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([
        provider("claudeAgent", ["claude-opus-5-5"]),
        provider("codex", ["gpt-6-astra"]),
      ]),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      runIsolatedPrompt: (input) =>
        Ref.update(calls, (recorded) => [...recorded, input]).pipe(Effect.andThen(runner(input))),
    }),
    ServerSettings.layerTest(),
    ThreadTurnPreamble.layer,
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const context = yield* Layer.build(
    Layer.effect(CouncilService.CouncilService, CouncilService.make).pipe(
      Layer.provideMerge(dependencies),
    ),
  );
  const council = yield* CouncilService.CouncilService.pipe(Effect.provide(context));
  const preamble = yield* ThreadTurnPreamble.ThreadTurnPreamble.pipe(Effect.provide(context));
  const latest = yield* Ref.make<CouncilSnapshot>({ councils: [] });
  yield* council.streamChanges.pipe(
    Stream.runForEach((snapshot) => Ref.set(latest, snapshot)),
    Effect.forkScoped,
  );
  yield* settle;
  const report = Ref.get(commands).pipe(
    Effect.map(
      (recorded) =>
        recorded.flatMap((command) =>
          command.type === "thread.message.assistant.delta" ? [command.delta] : [],
        )[0],
    ),
  );
  return { council, preamble, latest, calls, report };
});

const scored =
  (score: number): Runner =>
  () =>
    Effect.succeed({ text: `Here is my view. score: ${score}/10`, searches: 0 });

describe("CouncilService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("confirms with the thread's model at high effort, or the named model", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(scored(5));
        const confirm = yield* harness.council.prepare(THREAD, "Sell soup online to offices");
        expect(confirm.kind).toBe("confirm");
        expect(confirm.text).toContain("Idea: Sell soup online to offices");
        expect(confirm.text).toContain("☀ Optimist: claude-opus-5-5:high");
        expect(confirm.text).toContain("Rounds: 2 (+ chair) → 9 model runs");

        const named = yield* harness.council.prepare(
          THREAD,
          "astra --quick --no-web Sell soup online",
        );
        expect(named.text).toContain("Idea: Sell soup online");
        expect(named.text).toContain("Chair: gpt-6-astra:high");
        expect(named.text).toContain("Rounds: 1 (+ chair) → 5 model runs");
        expect(named.text).toContain("Web research: off");

        expect(yield* harness.council.prepare(THREAD, "help")).toMatchObject({ kind: "info" });
      }).pipe(Effect.scoped),
    );

    it.effect("opens in parallel, debates, lets the chair decide, and posts the report", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(scored(6));
        expect(yield* harness.council.start(THREAD, "Sell soup online to offices")).toEqual({
          started: true,
        });
        yield* settle;
        const calls = yield* Ref.get(harness.calls);
        expect(calls).toHaveLength(9);
        expect(calls.slice(0, 4).every((call) => call.web)).toBe(true);
        expect(calls[4]?.prompt).toContain("Debate round 1. The other members said:");
        expect(calls[8]?.web).toBe(false);
        expect(calls[8]?.systemPrompt).toContain("You are the Chair");

        const report = yield* harness.report;
        expect(report).toContain(
          "**Council score 6.0/10 — Optimist 6 · Skeptic 6 · CFO 6 · Operator 6**",
        );
        expect(yield* harness.preamble.apply(THREAD, "next")).toMatch(
          /^Council report \(automated\):\n\n# ⚖ Council report/,
        );
        expect((yield* Ref.get(harness.latest)).councils).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("skips a debate round when fewer than two members answered", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness((input) =>
          input.systemPrompt.startsWith("You are the Optimist") ||
          input.systemPrompt.startsWith("You are the Chair")
            ? Effect.succeed({ text: "score: 9/10", searches: 0 })
            : Effect.fail(
                new TextGenerationError({ operation: "runIsolatedPrompt", detail: "Timed out." }),
              ),
        );
        yield* harness.council.start(THREAD, "Sell soup online to offices");
        yield* settle;
        expect(yield* Ref.get(harness.calls)).toHaveLength(5);
        const report = yield* harness.report;
        expect(report).toContain("_Skipped: fewer than 2 members answered the previous round._");
        expect(report).toContain("- The Skeptic: opening failed — Timed out.");
      }).pipe(Effect.scoped),
    );

    it.effect("reports that the council could not sit when nobody answers", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(() =>
          Effect.fail(
            new TextGenerationError({ operation: "runIsolatedPrompt", detail: "Not signed in." }),
          ),
        );
        yield* harness.council.start(THREAD, "Sell soup online to offices");
        yield* settle;
        expect(yield* Ref.get(harness.calls)).toHaveLength(4);
        expect(yield* harness.report).toContain("The council could not sit.");
      }).pipe(Effect.scoped),
    );

    it.effect("allows one council per thread and cancels it without a report", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => Effect.never);
        yield* harness.council.start(THREAD, "Sell soup online to offices");
        yield* settle;
        expect((yield* Ref.get(harness.latest)).councils).toMatchObject([
          { phase: "opening statements", model: "claude-opus-5-5:high" },
        ]);
        expect(yield* harness.council.start(THREAD, "Another idea for the council")).toEqual({
          started: false,
          message: "A council is already sitting in this thread.",
        });
        expect(yield* harness.council.cancel(THREAD)).toBe(true);
        yield* settle;
        expect((yield* Ref.get(harness.latest)).councils).toEqual([]);
        expect(yield* harness.report).toBeUndefined();
      }).pipe(Effect.scoped),
    );
  });
});
