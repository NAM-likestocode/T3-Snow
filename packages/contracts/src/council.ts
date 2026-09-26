import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * T3-Snow Council: `/council <idea>` puts one idea before four advisors who
 * answer, debate, and a chair who decides. The report lands in the thread.
 */
export const CouncilSeatStatus = Schema.Literals([
  "waiting",
  "thinking",
  "searching",
  "done",
  "failed",
]);
export type CouncilSeatStatus = typeof CouncilSeatStatus.Type;

export const CouncilSeatProgress = Schema.Struct({
  id: Schema.String,
  icon: Schema.String,
  name: Schema.String,
  status: CouncilSeatStatus,
  /** The current search, the score and search count when done, or why it failed. */
  detail: Schema.NullOr(Schema.String),
});
export type CouncilSeatProgress = typeof CouncilSeatProgress.Type;

export const CouncilProgress = Schema.Struct({
  threadId: ThreadId,
  /** e.g. "opening statements", "debate round 1", "chair is deciding". */
  phase: Schema.String,
  startedAt: IsoDateTime,
  model: Schema.String,
  seats: Schema.Array(CouncilSeatProgress),
});
export type CouncilProgress = typeof CouncilProgress.Type;

export const CouncilSnapshot = Schema.Struct({
  councils: Schema.Array(CouncilProgress),
});
export type CouncilSnapshot = typeof CouncilSnapshot.Type;

export const CouncilCommandInput = Schema.Struct({
  threadId: ThreadId,
  /** Everything after `/council`. */
  args: Schema.String,
});
export type CouncilCommandInput = typeof CouncilCommandInput.Type;

export const CouncilPrepareResult = Schema.Struct({
  /** `confirm`: ask the user with `text` first; `info`: just show `text`. */
  kind: Schema.Literals(["confirm", "info"]),
  text: Schema.String,
});
export type CouncilPrepareResult = typeof CouncilPrepareResult.Type;

export const CouncilStartResult = Schema.Struct({
  started: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type CouncilStartResult = typeof CouncilStartResult.Type;

export const CouncilCancelInput = Schema.Struct({
  threadId: ThreadId,
});
export type CouncilCancelInput = typeof CouncilCancelInput.Type;

export const CouncilCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type CouncilCancelResult = typeof CouncilCancelResult.Type;
