/**
 * ThreadTurnPreamble - hidden text placed before a thread's turns (T3-Snow).
 *
 * Autopilot registers its instruction block here for every turn while it is
 * on. `RunExecutionService` puts it in front of the text it sends to the
 * provider; the stored message, and so the transcript, is unchanged.
 *
 * @module wake/ThreadTurnPreamble
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ThreadTurnPreamble extends Context.Service<
  ThreadTurnPreamble,
  {
    /** Text sent before every turn of the thread until cleared with `null`. */
    readonly setStanding: (
      threadId: ThreadId,
      key: string,
      text: string | null,
    ) => Effect.Effect<void>;
    /** The provider text for a turn: preambles first, then the user's message. */
    readonly apply: (threadId: ThreadId, messageText: string) => Effect.Effect<string>;
  }
>()("t3/wake/ThreadTurnPreamble") {}

export const make = Effect.sync(() => {
  const standing = new Map<ThreadId, Map<string, string>>();

  return ThreadTurnPreamble.of({
    setStanding: (threadId, key, text) =>
      Effect.sync(() => {
        const entries = standing.get(threadId) ?? new Map<string, string>();
        if (text === null) entries.delete(key);
        else entries.set(key, text);
        if (entries.size === 0) standing.delete(threadId);
        else standing.set(threadId, entries);
      }),
    apply: (threadId, messageText) =>
      Effect.sync(() => {
        const parts = [...(standing.get(threadId)?.values() ?? [])];
        return parts.length === 0 ? messageText : `${parts.join("\n\n")}\n\n---\n\n${messageText}`;
      }),
  });
});

export const layer = Layer.effect(ThreadTurnPreamble, make);
