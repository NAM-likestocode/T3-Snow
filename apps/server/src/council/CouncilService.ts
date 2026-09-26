// @effect-diagnostics globalDate:off - timestamps are ISO strings for contracts.
// @effect-diagnostics globalDateInEffect:off - same; the current time itself comes from Clock.
/**
 * CouncilService - `/council` for any thread (T3-Snow).
 *
 * Four advisors answer one idea in isolated model runs (no conversation,
 * project files, shell, or MCP tools; web search only when on), debate for
 * the chosen rounds, and a chair decides. Members may sit on different
 * providers. The report is posted into the thread as a message without
 * starting a turn, and is also handed to the thread's next turn so the agent
 * can answer follow-up questions about it.
 *
 * @module council/CouncilService
 */
import {
  CommandId,
  MessageId,
  type CouncilPrepareResult,
  type CouncilSeatProgress,
  type CouncilSnapshot,
  type CouncilStartResult,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { listHelperModelNames, resolveHelperModel } from "../helpers/helperModels.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadTurnPreamble from "../wake/ThreadTurnPreamble.ts";
import * as ThreadWakeQueue from "../wake/ThreadWakeQueue.ts";
import {
  CHAIR_SYSTEM_PROMPT,
  COUNCIL_DEFAULT_EFFORT,
  COUNCIL_MEMBERS,
  COUNCIL_MIN_IDEA_CHARS,
  COUNCIL_RUN_TIMEOUT_MS,
  COUNCIL_USAGE,
  buildChairPrompt,
  buildCouncilConfirmation,
  buildCouncilReport,
  buildDebatePrompt,
  buildMemberSystemPrompt,
  buildOpeningPrompt,
  buildTranscript,
  extractScore,
  memberById,
  parseCouncilArgs,
  splitModelEffort,
  type CouncilAnswer,
  type CouncilMember,
  type CouncilRound,
  type CouncilSeatId,
} from "./councilFormat.ts";

const PREAMBLE_KEY = "council";
/** How often a posted report re-checks whether the thread's turn has ended. */
const POST_CHECK_INTERVAL = "3 seconds";

export class CouncilService extends Context.Service<
  CouncilService,
  {
    /** Help, the model list, an error, or the confirmation text for a run. */
    readonly prepare: (threadId: ThreadId, args: string) => Effect.Effect<CouncilPrepareResult>;
    /** Starts a confirmed council in the background. */
    readonly start: (threadId: ThreadId, args: string) => Effect.Effect<CouncilStartResult>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly streamChanges: Stream.Stream<CouncilSnapshot>;
  }
>()("t3/council/CouncilService") {}

interface Seat {
  readonly selection: ModelSelection;
  readonly label: string;
}

interface CouncilPlan {
  readonly idea: string;
  readonly rounds: number;
  readonly web: boolean;
  readonly seats: Record<CouncilSeatId, Seat>;
  readonly modelSummary: string;
}

interface RunningCouncil {
  phase: string;
  readonly startedAt: string;
  readonly model: string;
  readonly seats: Map<CouncilSeatId, CouncilSeatProgress>;
  fiber: Fiber.Fiber<void> | null;
}

const SEAT_IDS: ReadonlyArray<CouncilSeatId> = ["optimist", "skeptic", "cfo", "operator", "chair"];

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const preamble = yield* ThreadTurnPreamble.ThreadTurnPreamble;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;

  const running = new Map<ThreadId, RunningCouncil>();
  const changes = yield* SubscriptionRef.make<CouncilSnapshot>({ councils: [] });
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowMs = Clock.currentTimeMillis;
  const isoNow = Effect.map(nowMs, (now) => new Date(now).toISOString());

  const publish = Effect.suspend(() =>
    SubscriptionRef.set(changes, {
      councils: [...running.entries()].map(([threadId, council]) => ({
        threadId,
        phase: council.phase,
        startedAt: council.startedAt,
        model: council.model,
        seats: SEAT_IDS.map((id) => council.seats.get(id)!),
      })),
    }),
  );

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  // --- planning ----------------------------------------------------------------

  const plan = (
    thread: OrchestrationThreadShell,
    args: string,
  ): Effect.Effect<CouncilPlan | { readonly info: string }> =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const council = Option.isSome(settings) ? settings.value.council : undefined;
      const parsed = parseCouncilArgs(args, council?.rounds ?? 2, council?.web ?? true);
      const providers = yield* providerRegistry.getProviders;
      if (parsed.kind === "help") return { info: COUNCIL_USAGE };
      if (parsed.kind === "models") {
        return { info: `Usable council models: ${listHelperModelNames(providers)}.` };
      }
      if (parsed.kind === "error") return { info: parsed.message };

      const resolve = (
        requested: string | undefined,
        effort: string | undefined,
        base: ModelSelection,
      ) => {
        const attempt = resolveHelperModel({
          providers,
          defaultSelection: base,
          requested,
          effort: effort ?? COUNCIL_DEFAULT_EFFORT,
          defaultName: "thread's model",
        });
        // The default effort is a preference; a model without it runs as configured.
        return attempt.ok || effort
          ? attempt
          : resolveHelperModel({
              providers,
              defaultSelection: base,
              requested,
              effort: undefined,
              defaultName: "thread's model",
            });
      };

      // The first word is a model only if it names one.
      if (parsed.modelToken) {
        const { model, effort } = splitModelEffort(parsed.modelToken);
        const named = resolve(model, effort, thread.modelSelection);
        if (named.ok) {
          if (parsed.idea.length < COUNCIL_MIN_IDEA_CHARS) {
            return { info: "Describe the idea in a sentence or two." };
          }
          const seat = { selection: named.selection, label: named.label };
          return {
            idea: parsed.idea,
            rounds: parsed.rounds,
            web: parsed.web,
            seats: Object.fromEntries(SEAT_IDS.map((id) => [id, seat])) as Record<
              CouncilSeatId,
              Seat
            >,
            modelSummary: named.label,
          };
        }
      }

      const seats = {} as Record<CouncilSeatId, Seat>;
      for (const id of SEAT_IDS) {
        const configured = council?.models[id] ?? null;
        const resolved = resolve(undefined, undefined, configured ?? thread.modelSelection);
        if (!resolved.ok) return { info: resolved.error };
        seats[id] = { selection: resolved.selection, label: resolved.label };
      }
      const labels = new Set(SEAT_IDS.map((id) => seats[id].label));
      return {
        idea: parsed.ideaWithModelToken,
        rounds: parsed.rounds,
        web: parsed.web,
        seats,
        modelSummary: labels.size === 1 ? seats.chair.label : "mixed models",
      };
    });

  const prepare: CouncilService["Service"]["prepare"] = (threadId, args) =>
    Effect.gen(function* () {
      if (running.has(threadId)) {
        return { kind: "info", text: "A council is already sitting in this thread." } as const;
      }
      const thread = yield* readShell(threadId);
      if (!thread) return { kind: "info", text: "This thread is not available." } as const;
      const result = yield* plan(thread, args);
      if ("info" in result) return { kind: "info", text: result.info } as const;
      return {
        kind: "confirm",
        text: buildCouncilConfirmation({
          idea: result.idea,
          seats: [
            ...COUNCIL_MEMBERS.map((member) => ({
              name: `${member.icon} ${member.short}`,
              model: result.seats[member.id].label,
            })),
            { name: "Chair", model: result.seats.chair.label },
          ],
          rounds: result.rounds,
          web: result.web,
        }),
      } as const;
    });

  // --- running -----------------------------------------------------------------

  const setSeat = (
    council: RunningCouncil,
    id: CouncilSeatId,
    status: CouncilSeatProgress["status"],
    detail: string | null,
  ) => {
    const seat = council.seats.get(id)!;
    council.seats.set(id, { ...seat, status, detail });
  };

  const runSeat = (
    council: RunningCouncil,
    id: CouncilSeatId,
    seat: Seat,
    systemPrompt: string,
    prompt: string,
    web: boolean,
  ) =>
    Effect.gen(function* () {
      setSeat(council, id, "thinking", null);
      let searches = 0;
      const result = yield* textGeneration.runIsolatedPrompt!({
        modelSelection: seat.selection,
        systemPrompt,
        prompt,
        web,
        timeoutMs: COUNCIL_RUN_TIMEOUT_MS,
        onSearch: (query) => {
          searches += 1;
          setSeat(council, id, "searching", query || "searching…");
        },
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        const reason = result.failure.detail.split("\n")[0]!.slice(0, 200);
        setSeat(council, id, "failed", reason);
        return { text: null, error: reason };
      }
      const score = extractScore(result.success.text);
      const searchNote = searches > 0 ? ` · ${searches} search${searches === 1 ? "" : "es"}` : "";
      setSeat(council, id, "done", `${score !== null ? `${score}/10` : "no score"}${searchNote}`);
      return { text: result.success.text, error: null };
    });

  const runMembers = (
    council: RunningCouncil,
    councilPlan: CouncilPlan,
    promptFor: (member: CouncilMember) => string,
  ) =>
    Effect.forEach(
      COUNCIL_MEMBERS,
      (member) =>
        runSeat(
          council,
          member.id,
          councilPlan.seats[member.id],
          buildMemberSystemPrompt(member, councilPlan.web),
          promptFor(member),
          councilPlan.web,
        ).pipe(Effect.map((answer): CouncilAnswer => ({ memberId: member.id, ...answer }))),
      { concurrency: "unbounded" },
    );

  const postReport = (threadId: ThreadId, report: string) =>
    Effect.gen(function* () {
      // The agent sees the report on its next turn; the thread shows it now or
      // right after the running turn, so it never lands inside a reply.
      yield* preamble.addOnce(threadId, PREAMBLE_KEY, `Council report (automated):\n\n${report}`);
      yield* Effect.gen(function* () {
        const thread = yield* readShell(threadId);
        return !thread || !ThreadWakeQueue.isThreadBusy(thread);
      }).pipe(
        Effect.repeat({ until: (idle) => idle, schedule: Schedule.spaced(POST_CHECK_INTERVAL) }),
      );
      const messageId = MessageId.make(yield* uuid);
      const createdAt = yield* isoNow;
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`server:council-report:${yield* uuid}`),
        threadId,
        messageId,
        delta: report,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`server:council-report:${yield* uuid}`),
        threadId,
        messageId,
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("council: report not posted", { cause })),
    );

  const convene = (threadId: ThreadId, council: RunningCouncil, councilPlan: CouncilPlan) =>
    Effect.gen(function* () {
      const startedMs = yield* nowMs;
      const rounds: CouncilRound[] = [];
      const notes: string[] = [];
      let runs = 0;

      council.phase = "opening statements";
      const opening = yield* runMembers(council, councilPlan, () =>
        buildOpeningPrompt(councilPlan.idea),
      );
      runs += COUNCIL_MEMBERS.length;
      rounds.push({ label: "Opening statements", answers: opening });
      for (const answer of opening) {
        if (answer.error)
          notes.push(`${memberById(answer.memberId).name}: opening failed — ${answer.error}`);
      }

      if (opening.every((answer) => !answer.text)) {
        yield* postReport(
          threadId,
          `# ⚖ Council report\n\nThe council could not sit.\n\n${notes.map((note) => `- ${note}`).join("\n")}`,
        );
        return;
      }

      for (let round = 2; round <= councilPlan.rounds; round += 1) {
        const label = `Debate round ${round - 1}`;
        const previous = rounds.at(-1)!.answers.filter((answer) => answer.text);
        if (previous.length < 2) {
          rounds.push({
            label,
            answers: [],
            skippedNote: "Skipped: fewer than 2 members answered the previous round.",
          });
          break;
        }
        council.phase = label.toLowerCase();
        for (const member of COUNCIL_MEMBERS) setSeat(council, member.id, "waiting", null);
        const answers = yield* runMembers(council, councilPlan, (member) =>
          buildDebatePrompt({
            idea: councilPlan.idea,
            round: round - 1,
            others: previous
              .filter((answer) => answer.memberId !== member.id)
              .map((answer) => ({ name: memberById(answer.memberId).name, text: answer.text! })),
          }),
        );
        runs += COUNCIL_MEMBERS.length;
        rounds.push({ label, answers });
        for (const answer of answers) {
          if (answer.error)
            notes.push(
              `${memberById(answer.memberId).name}: ${label.toLowerCase()} failed — ${answer.error}`,
            );
        }
      }

      council.phase = "chair is deciding";
      const chair = yield* runSeat(
        council,
        "chair",
        councilPlan.seats.chair,
        CHAIR_SYSTEM_PROMPT,
        buildChairPrompt(councilPlan.idea, buildTranscript(rounds)),
        false,
      );
      runs += 1;
      if (chair.error) notes.push(`Chair failed — ${chair.error}`);

      yield* postReport(
        threadId,
        buildCouncilReport({
          idea: councilPlan.idea,
          model: councilPlan.modelSummary,
          web: councilPlan.web,
          rounds,
          chair,
          notes,
          durationMs: (yield* nowMs) - startedMs,
          runs,
        }),
      );
    });

  const start: CouncilService["Service"]["start"] = (threadId, args) =>
    Effect.gen(function* () {
      if (!textGeneration.runIsolatedPrompt) {
        return { started: false, message: "Council is not available on this T3 Code server." };
      }
      if (running.has(threadId)) {
        return { started: false, message: "A council is already sitting in this thread." };
      }
      const thread = yield* readShell(threadId);
      if (!thread) return { started: false, message: "This thread is not available." };
      const councilPlan = yield* plan(thread, args);
      if ("info" in councilPlan) return { started: false, message: councilPlan.info };

      const council: RunningCouncil = {
        phase: "opening statements",
        startedAt: yield* isoNow,
        model: councilPlan.modelSummary,
        seats: new Map(
          SEAT_IDS.map((id) => {
            const member = id === "chair" ? null : memberById(id);
            return [
              id,
              {
                id,
                icon: member?.icon ?? "⚖",
                name: member?.short ?? "Chair",
                status: "waiting",
                detail: null,
              } satisfies CouncilSeatProgress,
            ];
          }),
        ),
        fiber: null,
      };
      running.set(threadId, council);
      yield* publish;
      // Seats change inside provider callbacks; publish once a second while it sits.
      const ticker = Effect.repeat(publish, Schedule.spaced("1 second"));
      council.fiber = yield* Effect.forkIn(
        Effect.raceFirst(convene(threadId, council, councilPlan), Effect.asVoid(ticker)).pipe(
          Effect.catchCause((cause) => Effect.logWarning("council: run failed", { cause })),
          Effect.ensuring(
            Effect.suspend(() => {
              running.delete(threadId);
              return publish;
            }),
          ),
        ),
        scope,
      );
      return { started: true };
    });

  const cancel: CouncilService["Service"]["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const council = running.get(threadId);
      if (!council) return false;
      if (council.fiber) yield* Fiber.interrupt(council.fiber);
      running.delete(threadId);
      yield* publish;
      return true;
    });

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> =>
    (event.type === "thread.deleted" || event.type === "thread.archived") &&
    running.has(event.payload.threadId)
      ? Effect.asVoid(cancel(event.payload.threadId))
      : Effect.void;

  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(Stream.runForEach(events, onEvent));

  return CouncilService.of({
    prepare,
    start,
    cancel,
    streamChanges: SubscriptionRef.changes(changes),
  });
});

export const layer = Layer.effect(CouncilService, make);
