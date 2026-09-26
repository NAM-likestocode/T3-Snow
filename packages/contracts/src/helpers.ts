import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * T3-Snow helpers: an agent hands a task to a helper through the `subagent`
 * MCP tool. The helper runs in its own thread on any configured model and
 * its report comes back to the thread that started it.
 */
export const HelperRunStatus = Schema.Literals(["running", "completed", "failed", "stopped"]);
export type HelperRunStatus = typeof HelperRunStatus.Type;

export const HelperRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The thread that started the helper and gets its report. */
  parentThreadId: ThreadId,
  /** The helper's own thread. */
  threadId: ThreadId,
  name: Schema.String,
  profile: Schema.String,
  model: Schema.String,
  status: HelperRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type HelperRun = typeof HelperRun.Type;

export const HelperRunsSnapshot = Schema.Struct({
  runs: Schema.Array(HelperRun),
});
export type HelperRunsSnapshot = typeof HelperRunsSnapshot.Type;

export const HelperStopInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
});
export type HelperStopInput = typeof HelperStopInput.Type;

export const HelperStopResult = Schema.Struct({
  stopped: Schema.Boolean,
});
export type HelperStopResult = typeof HelperStopResult.Type;
