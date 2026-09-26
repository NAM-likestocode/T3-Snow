/**
 * ThreadTurnPreamble - hidden text placed before a thread's next turns (T3-Snow).
 *
 * Features that must reach the agent on its next turn, whatever the provider,
 * register text here: Autopilot's instruction block (every turn while it is
 * on) and one-off context such as a Council report (the next turn only).
 * `ProviderCommandReactor` puts it in front of the text it sends to the
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
    /** Text sent before the thread's next turn only. */
    readonly addOnce: (threadId: ThreadId, key: string, text: string) => Effect.Effect<void>;
    /** The provider text for a turn: preambles first, then the user's message. */
    readonly apply: (threadId: ThreadId, messageText: string) => Effect.Effect<string>;
  }
>()("t3/wake/ThreadTurnPreamble") {}

export const make = Effect.sync(() => {
  const standing = new Map<ThreadId, Map<string, string>>();
  const once = new Map<ThreadId, Map<string, string>>();

  const put = (
    store: Map<ThreadId, Map<string, string>>,
    threadId: ThreadId,
    key: string,
    text: string | null,
  ) => {
    const entries = store.get(threadId) ?? new Map<string, string>();
    if (text === null) entries.delete(key);
    else entries.set(key, text);
    if (entries.size === 0) store.delete(threadId);
    else store.set(threadId, entries);
  };

  return ThreadTurnPreamble.of({
    setStanding: (threadId, key, text) => Effect.sync(() => put(standing, threadId, key, text)),
    addOnce: (threadId, key, text) => Effect.sync(() => put(once, threadId, key, text)),
    apply: (threadId, messageText) =>
      Effect.sync(() => {
        const parts = [
          ...(standing.get(threadId)?.values() ?? []),
          ...(once.get(threadId)?.values() ?? []),
        ];
        once.delete(threadId);
        return parts.length === 0 ? messageText : `${parts.join("\n\n")}\n\n---\n\n${messageText}`;
      }),
  });
});

export const layer = Layer.effect(ThreadTurnPreamble, make);
