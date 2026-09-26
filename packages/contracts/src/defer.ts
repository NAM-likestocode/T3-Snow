import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * T3-Snow deferred wake-ups: an agent arms a trigger with the `defer` MCP
 * tool and the environment posts a message into its thread when it fires.
 * Triggers live in the environment's memory, so clients only observe them.
 */
export const DeferTriggerKind = Schema.Literals(["at", "check"]);
export type DeferTriggerKind = typeof DeferTriggerKind.Type;

export const DeferTrigger = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  kind: DeferTriggerKind,
  note: Schema.String,
  armedAt: IsoDateTime,
  /** Time triggers: when it fires. Condition triggers: when it gives up. */
  firesAt: IsoDateTime,
  check: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  pollMs: Schema.optional(Schema.Number),
  /** Condition triggers: checks run so far and the latest result. */
  checks: Schema.Number,
  lastExit: Schema.NullOr(Schema.Number),
});
export type DeferTrigger = typeof DeferTrigger.Type;

export const DeferTriggersSnapshot = Schema.Struct({
  triggers: Schema.Array(DeferTrigger),
});
export type DeferTriggersSnapshot = typeof DeferTriggersSnapshot.Type;

export const DeferCancelInput = Schema.Struct({
  triggerId: TrimmedNonEmptyString,
});
export type DeferCancelInput = typeof DeferCancelInput.Type;

export const DeferCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type DeferCancelResult = typeof DeferCancelResult.Type;
