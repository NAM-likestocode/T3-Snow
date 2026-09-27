// @effect-diagnostics globalDate:off - "2am" and "14:30" are wall-clock times in the local zone.
/**
 * Pure helpers for the `defer` wake-up tool (T3-Snow). Behavior, limits, and
 * wording follow the Pi `defer` extension so agents and user instructions
 * written for it keep working unchanged.
 *
 * @module defer/deferFormat
 */

export const DEFER_DEFAULT_POLL_MS = 15_000;
export const DEFER_MIN_POLL_MS = 1_000;
export const DEFER_DEFAULT_TIMEOUT_MS = 60 * 60_000;
export const DEFER_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFER_CHECK_RUN_TIMEOUT_MS = 30_000;
export const DEFER_RUN_TIMEOUT_MS = 60_000;
export const DEFER_MAX_CAPTURE_BYTES = 1024 * 1024;
export const DEFER_MAX_TRIGGERS_PER_THREAD = 10;
export const DEFER_MAX_TRIGGERS_TOTAL = 100;
/** Exit code reported when a check or run command is killed for taking too long. */
/** T3-Snow: the earliest a wake-up may fire, so a wake-up cannot re-arm itself in a tight loop. */
export const DEFER_MIN_DELAY_MS = 30_000;
/** T3-Snow: wake-ups one thread may fire per rolling hour before arming is refused. */
export const DEFER_MAX_FIRES_PER_HOUR = 20;
/** Exit code reported for a `run` skipped because the thread left Full access. */
export const DEFER_NOT_RUN_EXIT_CODE = 126;

export const DEFER_TIMED_OUT_EXIT_CODE = 124;

const OUTPUT_MAX_LINES = 40;
const OUTPUT_HEAD_LINES = 28;
const OUTPUT_TAIL_LINES = 12;
const OUTPUT_MAX_CHARS = 4_000;

const RELATIVE_UNITS_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Parses `in 30m`, `2am`, `14:30`, `2:15pm`, `9`, or anything `Date.parse`
 * understands (ISO timestamps), in the machine's local time zone. A clock
 * time that already passed today means tomorrow. Returns null when the text
 * is not a time.
 */
export function parseDeferTime(input: string, now: Date): Date | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const relative = /^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
  if (relative) {
    const unit = RELATIVE_UNITS_MS[relative[2]!];
    if (unit === undefined) return null;
    return new Date(now.getTime() + Number(relative[1]) * unit);
  }

  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = clock[2] === undefined ? 0 : Number(clock[2]);
    const meridiem = clock[3];
    if (meridiem) {
      if (hours < 1 || hours > 12) return null;
      if (meridiem === "am") hours = hours === 12 ? 0 : hours;
      else hours = hours === 12 ? 12 : hours + 12;
    }
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }

  const parsed = Date.parse(input.trim());
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** `45s`, `4m12s`, `2h05m`, `3d4h`; zero trailing parts are dropped (`1h`). */
export function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${pad2(seconds)}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h${pad2(minutes)}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Keeps the first 28 and last 12 of more than 40 lines, then caps at 4,000 characters. */
export function trimDeferOutput(output: string): {
  readonly text: string;
  readonly clipped: boolean;
} {
  const lines = output.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  let clipped = false;
  let text: string;
  if (lines.length > OUTPUT_MAX_LINES) {
    clipped = true;
    const omitted = lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES;
    text = [
      ...lines.slice(0, OUTPUT_HEAD_LINES),
      `… ${omitted} lines omitted …`,
      ...lines.slice(-OUTPUT_TAIL_LINES),
    ].join("\n");
  } else {
    text = lines.join("\n");
  }
  if (text.length > OUTPUT_MAX_CHARS) {
    clipped = true;
    text = `${text.slice(0, OUTPUT_MAX_CHARS)}\n… truncated at ${OUTPUT_MAX_CHARS} characters …`;
  }
  return { text, clipped };
}

/** `d` plus five random lowercase letters or digits, e.g. `dk3x9q`. */
export function makeDeferTriggerId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "d";
  for (let index = 0; index < 5; index += 1) {
    id += alphabet[Math.floor(random() * alphabet.length)];
  }
  return id;
}

export type DeferFireReason =
  | { readonly kind: "due" }
  | { readonly kind: "condition"; readonly check: string; readonly afterMs: number }
  | {
      readonly kind: "timeout";
      readonly afterMs: number;
      readonly checks: number;
      readonly lastExit: number | null;
    }
  /** T3-Snow: the thread left Full access, so the check stopped running. */
  | { readonly kind: "blocked"; readonly check: string };

export function describeFireReason(reason: DeferFireReason): string {
  switch (reason.kind) {
    case "due":
      return "scheduled time reached";
    case "condition":
      return `\`${reason.check}\` held after ${formatCompactDuration(reason.afterMs)}`;
    case "timeout":
      return `gave up after ${formatCompactDuration(reason.afterMs)}, ${reason.checks} checks, last exit ${
        reason.lastExit ?? "–"
      }`;
    case "blocked":
      return `stopped checking \`${reason.check}\`: the thread is no longer in Full access mode`;
  }
}

export interface DeferRunResult {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}

/** The message a firing trigger posts into its thread (Pi's format). */
export function buildDeferWakeMessage(input: {
  readonly id: string;
  readonly reason: DeferFireReason;
  readonly note: string;
  readonly run?: DeferRunResult | undefined;
}): string {
  const header = `${input.id} fired: ${describeFireReason(input.reason)}\n${input.note}`;
  if (!input.run) return header;
  const output = input.run.output.trim() ? trimDeferOutput(input.run.output).text : "(no output)";
  return `${header}\n\n$ ${input.run.command} (exit ${input.run.exitCode})\n${output}`;
}

/** Posted after a restart for every trigger that was armed when T3 Code stopped. */
export function buildDeferLostMessage(input: {
  readonly id: string;
  readonly note: string;
}): string {
  return `${input.id} lost: T3 Code restarted before it fired\n${input.note}\n\nCheck on it yourself and arm a new trigger if it is still needed.`;
}
