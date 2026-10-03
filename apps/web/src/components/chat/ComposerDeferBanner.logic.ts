import type { DeferTrigger } from "@t3tools/contracts";

/** `45s`, `4m12s`, `2h05m`, `3d4h`, matching the wake-up messages agents receive. */
export function formatDeferDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0
      ? `${totalMinutes}m`
      : `${totalMinutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h${String(minutes).padStart(2, "0")}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}

/**
 * How a trigger is doing, as the panel shows it:
 * - `time`: waiting for a clock time
 * - `pending`: a condition not checked yet
 * - `checking`: a condition checked and not yet true (exit 0 or 1)
 * - `broken`: the check itself is failing (exit above 1, e.g. not found or timed out)
 */
export type DeferTriggerState = "time" | "pending" | "checking" | "broken";

export function deferTriggerState(trigger: DeferTrigger): DeferTriggerState {
  if (trigger.kind === "at") return "time";
  if (trigger.checks === 0 || trigger.lastExit === null) return "pending";
  return trigger.lastExit > 1 ? "broken" : "checking";
}

/** Right-hand status text: a countdown, or check count, last exit, and time left. */
export function describeDeferStatus(trigger: DeferTrigger, now: number): string {
  const remaining = formatDeferDuration(Date.parse(trigger.firesAt) - now);
  if (trigger.kind === "at") return `in ${remaining}`;
  const lastExit = trigger.lastExit === null ? "–" : String(trigger.lastExit);
  return `${trigger.checks}× · exit ${lastExit} · ${remaining} left`;
}
