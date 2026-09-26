/**
 * Council wording, parsing, and report building (T3-Snow), following the Pi
 * `/council` extension: four advisors answer one idea, debate, and a chair
 * decides.
 *
 * @module council/councilFormat
 */
import { formatCompactDuration } from "../defer/deferFormat.ts";

export const COUNCIL_DEFAULT_ROUNDS = 2;
export const COUNCIL_MAX_ROUNDS = 3;
export const COUNCIL_MIN_IDEA_CHARS = 8;
export const COUNCIL_MAX_IDEA_CHARS = 8_000;
export const COUNCIL_RUN_TIMEOUT_MS = 8 * 60_000;
export const COUNCIL_DEFAULT_EFFORT = "high";
const EFFORT_WORDS = ["xhigh", "max", "high", "medium", "low"] as const;

export type CouncilMemberId = "optimist" | "skeptic" | "cfo" | "operator";
export type CouncilSeatId = CouncilMemberId | "chair";

export interface CouncilMember {
  readonly id: CouncilMemberId;
  readonly icon: string;
  readonly name: string;
  readonly short: string;
  readonly role: string;
}

export const COUNCIL_MEMBERS: ReadonlyArray<CouncilMember> = [
  {
    id: "optimist",
    icon: "☀",
    name: "The Optimist",
    short: "Optimist",
    role: "You are the Optimist: the person who finds the real upside everyone else misses. Look for the strongest honest version of this idea: the best-case customer, the unfair advantage, the tailwind, the fastest path to a first win. Argue for it with evidence, not enthusiasm. A weak optimistic case stated honestly is more useful than hype. You are allowed to say the upside is small if that is the truth.",
  },
  {
    id: "skeptic",
    icon: "☁",
    name: "The Skeptic",
    short: "Skeptic",
    role: "You are the Skeptic: the failure analyst. Assume this idea fails and explain exactly how: the most likely killer, the hidden work, the competitor already doing it, the legal or platform risk, the reason people say they want it but never pay. Rank risks by probability times damage. Attack the idea, never the person. If a risk is cheap to remove, say so instead of treating it as fatal.",
  },
  {
    id: "cfo",
    icon: "€",
    name: "The CFO",
    short: "CFO",
    role: "You are the CFO: only money matters to you. Work out the unit economics out loud: who pays, how much, how often, what it costs to serve one customer, the gross margin, the cash needed before revenue, and the payback period. State a rough break-even number of customers and the price point that makes it work. Show your arithmetic in one short line each. Call out the single number the whole business hinges on.",
  },
  {
    id: "operator",
    icon: "⚙",
    name: "The Operator",
    short: "Operator",
    role: "You are the Operator: you care about what actually happens in the real world. Describe the most likely real scenario: what the first 90 days look like, who has to do the work, what skills or permissions are missing, how long the boring parts take, and where the plan meets reality. Give the smallest concrete test that would prove or kill this idea within a few weeks. Be neither hopeful nor gloomy: be accurate.",
  },
];

const SHARED_RULES =
  "You are one voice on a four-person council reviewing a single idea for one person, not a committee report writer. Judge the idea itself. Stay in character, but never invent facts, numbers, or sources. Mark every number as either researched (with a link), a stated assumption, or a rough guess. Be specific and concrete. No filler, no motivational language, no restating the idea back at length. Never claim you did work your tools cannot do. You cannot read the user's files, run code, or contact anyone.";

const WEB_RULES =
  "You have web search and page fetching. Use at most 4 focused searches, and only for facts that would change the verdict: market size, real pricing, direct competitors, regulation, or hard cost inputs. Prefer primary sources and include inline links for anything load-bearing. If a fact cannot be verified quickly, say so and move on.";

const NO_WEB_RULES =
  "You have no tools and no internet. Reason from what you know, label your knowledge cutoff risk, and clearly flag which numbers a human should verify before acting.";

const OPENING_FORMAT = `Answer in under 400 words, in this format:
**Position** - 2-3 sentences.
**Strongest points** - 3-4 bullets.
**What must be true** - 2-3 bullets.
**Verdict** - \`score: N/10\` and \`confidence: low|medium|high\`.`;

const DEBATE_FORMAT = `Reply in under 350 words, in this format:
**Where they are right** - name the member and the point you concede.
**Where they are wrong** - rebut with a reason or a number.
**What would settle it**
**Updated verdict** - \`score: N/10\`, confidence, and whether and why your score moved.`;

export function buildMemberSystemPrompt(member: CouncilMember, web: boolean): string {
  return [member.role, SHARED_RULES, web ? WEB_RULES : NO_WEB_RULES, OPENING_FORMAT].join("\n\n");
}

export function buildOpeningPrompt(idea: string): string {
  return `The idea under review: ${idea}\n\nGive your opening position on this idea now, in your assigned format.`;
}

export function buildDebatePrompt(input: {
  readonly idea: string;
  readonly round: number;
  readonly others: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}): string {
  const answers = input.others
    .map((other) => `### ${other.name}\n${other.text.trim()}`)
    .join("\n\n");
  return `The idea under review: ${input.idea}\n\nDebate round ${input.round}. The other members said:\n\n${answers}\n\n${DEBATE_FORMAT}`;
}

export const CHAIR_SYSTEM_PROMPT = `You are the Chair of a four-person council that just reviewed one idea. The Optimist, the Skeptic, the CFO and the Operator each gave an opening position and then debated. Your job is to decide, not to summarize. Weigh the arguments by evidence quality, not by who spoke loudest. Discount any claim that rests on an unverified number. Never introduce new facts of your own. You have no tools.

Answer in under 450 words, in plain language, in this format:
## Verdict
One line: **Smart**, **Smart, but only if…**, or **Not smart**, then one sentence, then the council's score range.
## Why
3-5 bullets.
## The one thing that kills it
## The money
Say which numbers were verified and which are assumed.
## Cheapest way to find out
2-4 steps.
## Where the council split
1-3 bullets.`;

export function buildChairPrompt(idea: string, transcript: string): string {
  return `The idea under review: ${idea}\n\nThe council's full debate:\n\n${transcript}\n\nDecide now, in your assigned format.`;
}

/** The last `score: N/10` in a text, clamped to 0-10. */
export function extractScore(text: string): number | null {
  const matches = [...text.matchAll(/score\W{0,3}\s*(\d{1,2}(?:\.\d)?)\s*\/\s*10/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  const value = Number(last[1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : null;
}

export function buildScoreLine(
  scores: ReadonlyArray<{ readonly short: string; readonly score: number | null }>,
): string | null {
  const known = scores.filter((entry) => entry.score !== null);
  if (known.length === 0) return null;
  const average = known.reduce((sum, entry) => sum + entry.score!, 0) / known.length;
  const parts = known.map((entry) => `${entry.short} ${formatScore(entry.score!)}`).join(" · ");
  return `Council score ${average.toFixed(1)}/10 — ${parts}`;
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

// --- command parsing ---------------------------------------------------------

export type CouncilCommand =
  | { readonly kind: "help" }
  | { readonly kind: "models" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "run";
      /** First word, when it may name a model; the service decides. */
      readonly modelToken: string | null;
      readonly rounds: number;
      readonly web: boolean;
      /** The idea without the model word. */
      readonly idea: string;
      /** The idea when the first word turns out not to be a model. */
      readonly ideaWithModelToken: string;
    };

export const COUNCIL_USAGE = `Usage: /council [model] [--rounds N] [--quick] [--no-web] <idea>
- model: optional, e.g. opus5, opus5max, opus5:xhigh, gpt-6-astra. Default: this thread's model (or the Council models in settings).
- --rounds N: 1-3 (default 2). --quick is 1 round.
- --no-web: reasoning only, no web research.
/council models lists usable models.`;

/** Parses `/council` arguments (the text after the command). */
export function parseCouncilArgs(
  raw: string,
  defaultRounds: number,
  defaultWeb: boolean,
): CouncilCommand {
  const text = raw.trim();
  if (/^help$/i.test(text) || text === "")
    return text === "" ? { kind: "error", message: COUNCIL_USAGE } : { kind: "help" };
  if (/^models$/i.test(text)) return { kind: "models" };

  let rounds = defaultRounds;
  let web = defaultWeb;
  const words: string[] = [];
  const tokens = text.split(/(\s+)/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--quick") {
      rounds = 1;
    } else if (token === "--no-web") {
      web = false;
    } else if (token === "--web") {
      web = true;
    } else if (token === "--rounds") {
      // Skip the whitespace token to reach the value.
      const value = Number(tokens[index + 2]);
      if (!Number.isInteger(value) || value < 1 || value > COUNCIL_MAX_ROUNDS) {
        return {
          kind: "error",
          message: `--rounds takes a number from 1 to ${COUNCIL_MAX_ROUNDS}.`,
        };
      }
      rounds = value;
      index += 2;
    } else {
      words.push(token);
    }
  }
  const rest = words.join("").replace(/\s+/g, " ").trim();
  const [first = "", ...others] = rest.split(" ");
  const idea = others.join(" ").trim();
  const clip = (value: string) => value.slice(0, COUNCIL_MAX_IDEA_CHARS);
  if (rest.length < COUNCIL_MIN_IDEA_CHARS) {
    return { kind: "error", message: "Describe the idea in a sentence or two." };
  }
  return {
    kind: "run",
    modelToken: first && !first.includes(" ") ? first : null,
    rounds,
    web,
    idea: clip(idea),
    ideaWithModelToken: clip(rest),
  };
}

/** Splits `opus5max` or `opus5:xhigh` into a model name and an effort. */
export function splitModelEffort(token: string): {
  readonly model: string;
  readonly effort: string | undefined;
} {
  const colon = token.lastIndexOf(":");
  if (colon > 0)
    return { model: token.slice(0, colon), effort: token.slice(colon + 1) || undefined };
  const lower = token.toLowerCase();
  for (const word of EFFORT_WORDS) {
    if (lower.endsWith(word) && lower.length > word.length) {
      return { model: token.slice(0, -word.length).replace(/[-_]$/, ""), effort: word };
    }
  }
  return { model: token, effort: undefined };
}

// --- report ------------------------------------------------------------------

export interface CouncilAnswer {
  readonly memberId: CouncilMemberId;
  readonly text: string | null;
  readonly error: string | null;
}

export interface CouncilRound {
  readonly label: string;
  readonly answers: ReadonlyArray<CouncilAnswer>;
  readonly skippedNote?: string | undefined;
}

export function memberById(id: CouncilMemberId): CouncilMember {
  return COUNCIL_MEMBERS.find((member) => member.id === id)!;
}

/** Each member's latest answer across rounds. */
export function latestAnswers(rounds: ReadonlyArray<CouncilRound>): Map<CouncilMemberId, string> {
  const latest = new Map<CouncilMemberId, string>();
  for (const round of rounds) {
    for (const answer of round.answers) if (answer.text) latest.set(answer.memberId, answer.text);
  }
  return latest;
}

export function buildTranscript(rounds: ReadonlyArray<CouncilRound>): string {
  return rounds
    .map((round) =>
      [
        `## ${round.label}`,
        ...round.answers.map((answer) => {
          const member = memberById(answer.memberId);
          return `### ${member.icon} ${member.name}\n${answer.text?.trim() ?? `(${answer.error ?? "no answer"})`}`;
        }),
      ].join("\n\n"),
    )
    .join("\n\n");
}

export function buildCouncilReport(input: {
  readonly idea: string;
  readonly model: string;
  readonly web: boolean;
  readonly rounds: ReadonlyArray<CouncilRound>;
  readonly chair: { readonly text: string | null; readonly error: string | null };
  readonly notes: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly runs: number;
}): string {
  const latest = latestAnswers(input.rounds);
  const scoreLine = buildScoreLine(
    COUNCIL_MEMBERS.map((member) => ({
      short: member.short,
      score: latest.has(member.id) ? extractScore(latest.get(member.id)!) : null,
    })),
  );
  const debate = input.rounds.map((round) => {
    if (round.skippedNote) return `## ${round.label}\n\n_${round.skippedNote}_`;
    return [
      `## ${round.label}`,
      ...round.answers.map((answer) => {
        const member = memberById(answer.memberId);
        const score = answer.text ? extractScore(answer.text) : null;
        const heading = `### ${member.icon} ${member.name}${score !== null ? ` — ${formatScore(score)}/10` : ""}`;
        return `${heading}\n\n${answer.text?.trim() ?? `_${answer.error ?? "No answer."}_`}`;
      }),
    ].join("\n\n");
  });
  const idea = input.idea.length > 300 ? `${input.idea.slice(0, 300)}…` : input.idea;
  return [
    "# ⚖ Council report",
    `**Idea:** ${idea}`,
    `**Model:** ${input.model} · **Web research:** ${input.web ? "on" : "off"}`,
    scoreLine ? `**${scoreLine}**` : "_No member gave a score._",
    input.chair.text?.trim() ??
      `_The chair could not decide: ${input.chair.error ?? "no answer"}._`,
    "---",
    "# Full debate",
    ...debate,
    ...(input.notes.length > 0
      ? ["## Notes", input.notes.map((note) => `- ${note}`).join("\n")]
      : []),
    `_${input.runs} model runs · ${formatCompactDuration(input.durationMs)}_`,
  ].join("\n\n");
}

export function buildCouncilConfirmation(input: {
  readonly idea: string;
  readonly seats: ReadonlyArray<{ readonly name: string; readonly model: string }>;
  readonly rounds: number;
  readonly web: boolean;
}): string {
  const idea = input.idea.length > 160 ? `${input.idea.slice(0, 160)}…` : input.idea;
  const runs = 4 * input.rounds + 1;
  return [
    "Convene the council?",
    `Idea: ${idea}`,
    ...input.seats.map((seat) => `${seat.name}: ${seat.model}`),
    `Rounds: ${input.rounds} (+ chair) → ${runs} model runs`,
    input.web
      ? "Web research: ON — your idea text is sent to the search provider"
      : "Web research: off — reasoning only",
    "This runs several full model sessions and costs real tokens.",
  ].join("\n");
}
