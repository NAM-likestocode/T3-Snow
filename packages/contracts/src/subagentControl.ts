import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * T3-Snow: look inside, stop, and message a provider's native subagent (a
 * Claude Task agent or a Codex child agent) from the Agents panel. `taskId`
 * is the id the Agents panel keys the subagent by.
 */
export const SubagentTranscriptEntryKind = Schema.Literals([
  "prompt",
  "text",
  "thinking",
  "tool",
  "tool-result",
]);
export type SubagentTranscriptEntryKind = typeof SubagentTranscriptEntryKind.Type;

export const SubagentTranscriptEntry = Schema.Struct({
  kind: SubagentTranscriptEntryKind,
  text: Schema.String,
  toolName: Schema.optional(Schema.String),
});
export type SubagentTranscriptEntry = typeof SubagentTranscriptEntry.Type;

export const SubagentTarget = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type SubagentTarget = typeof SubagentTarget.Type;

export const SubagentTranscriptResult = Schema.Struct({
  /** Null when the provider keeps no readable transcript for this subagent. */
  entries: Schema.NullOr(Schema.Array(SubagentTranscriptEntry)),
  /** Entries dropped from the start to keep the reply small. */
  omitted: Schema.Number,
});
export type SubagentTranscriptResult = typeof SubagentTranscriptResult.Type;

export const SubagentMessageInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  /** The subagent's name as the panel shows it, so the main agent knows who is meant. */
  title: Schema.String,
  text: TrimmedNonEmptyString,
});
export type SubagentMessageInput = typeof SubagentMessageInput.Type;

export const SubagentControlResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type SubagentControlResult = typeof SubagentControlResult.Type;
