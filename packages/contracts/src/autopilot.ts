import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * T3-Snow Autopilot: `/autopilot <goal>` lets a thread's agent work on a goal
 * on its own until it is done, then turns itself off. The environment keeps
 * the state; clients show it and can stop or resume it.
 */
export const AutopilotStatus = Schema.Literals(["active", "paused"]);
export type AutopilotStatus = typeof AutopilotStatus.Type;

export const AutopilotThreadState = Schema.Struct({
  threadId: ThreadId,
  goal: Schema.String,
  startedAt: IsoDateTime,
  /** `paused` after T3 Code restarted while it was on. */
  status: AutopilotStatus,
});
export type AutopilotThreadState = typeof AutopilotThreadState.Type;

export const AutopilotSnapshot = Schema.Struct({
  threads: Schema.Array(AutopilotThreadState),
});
export type AutopilotSnapshot = typeof AutopilotSnapshot.Type;

export const AutopilotStartInput = Schema.Struct({
  threadId: ThreadId,
  goal: TrimmedNonEmptyString,
});
export type AutopilotStartInput = typeof AutopilotStartInput.Type;

export const AutopilotStartResult = Schema.Struct({
  started: Schema.Boolean,
  /** Why it did not start, or a caution when it did. */
  message: Schema.optional(Schema.String),
});
export type AutopilotStartResult = typeof AutopilotStartResult.Type;

export const AutopilotThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type AutopilotThreadInput = typeof AutopilotThreadInput.Type;

export const AutopilotThreadResult = Schema.Struct({
  changed: Schema.Boolean,
});
export type AutopilotThreadResult = typeof AutopilotThreadResult.Type;
