// @effect-diagnostics globalDateInEffect:off - createdAt stamps use the Clock time.
/**
 * SubagentControl - look inside, stop, and message a provider's native
 * subagents from the Agents panel (T3-Snow).
 *
 * The provider-specific parts live on the adapters (`readSubagentTranscript`,
 * `stopSubagent`). Messaging has no provider hook: no provider lets a user
 * type into a running subagent, so the message goes to the thread's main
 * agent, addressed to the subagent, and the main agent relays it.
 *
 * @module agents/SubagentControl
 */
import {
  CommandId,
  MessageId,
  type SubagentControlResult,
  type SubagentMessageInput,
  type SubagentTarget,
  type SubagentTranscriptResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

export class SubagentControl extends Context.Service<
  SubagentControl,
  {
    readonly transcript: (target: SubagentTarget) => Effect.Effect<SubagentTranscriptResult>;
    readonly stop: (target: SubagentTarget) => Effect.Effect<SubagentControlResult>;
    readonly message: (input: SubagentMessageInput) => Effect.Effect<SubagentControlResult>;
  }
>()("t3/agents/SubagentControl") {}

export function buildSubagentMessage(input: {
  readonly title: string;
  readonly taskId: string;
  readonly text: string;
}): string {
  const name = input.title.trim() || "your subagent";
  return `Message from the user for your subagent "${name}" (id ${input.taskId}):\n\n${input.text.trim()}\n\nPass this on to that subagent if you can (for example by sending it a message by its id), or act on it yourself if it has finished.`;
}

function errorText(cause: unknown): string {
  if (cause && typeof cause === "object" && "detail" in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
  }
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

export const make = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const registry = yield* ProviderAdapterRegistry;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  /** The thread's adapter and persisted binding, or undefined. */
  const adapterFor = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(
        yield* directory.getBinding(threadId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (!binding?.providerInstanceId) return undefined;
      const adapter = yield* registry
        .getByInstance(binding.providerInstanceId)
        .pipe(Effect.orElseSucceed(() => undefined));
      return adapter ? { adapter, binding } : undefined;
    });

  const transcript: SubagentControl["Service"]["transcript"] = (target) =>
    Effect.gen(function* () {
      const routed = yield* adapterFor(target.threadId);
      if (!routed?.adapter.readSubagentTranscript) return { entries: null, omitted: 0 };
      const result = yield* routed.adapter
        .readSubagentTranscript({
          threadId: target.threadId,
          taskId: target.taskId,
          resumeCursor: routed.binding.resumeCursor ?? null,
        })
        .pipe(Effect.orElseSucceed(() => null));
      return result
        ? { entries: result.entries, omitted: result.omitted }
        : { entries: null, omitted: 0 };
    });

  const stop: SubagentControl["Service"]["stop"] = (target) =>
    Effect.gen(function* () {
      const routed = yield* adapterFor(target.threadId);
      if (!routed || !(yield* routed.adapter.hasSession(target.threadId))) {
        return { ok: false, message: "This thread's agent is not running." };
      }
      if (!routed.adapter.stopSubagent) {
        return {
          ok: false,
          message: "This provider can't stop a single agent. Stop the whole turn instead.",
        };
      }
      return yield* routed.adapter.stopSubagent(target.threadId, target.taskId).pipe(
        Effect.as({ ok: true }),
        Effect.catch((cause) => Effect.succeed({ ok: false, message: errorText(cause) })),
      );
    });

  const message: SubagentControl["Service"]["message"] = (input) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* snapshots
          .getThreadShellById(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (!thread || thread.archivedAt !== null) {
        return { ok: false, message: "This thread is not available." };
      }
      const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:subagent-message:${yield* uuid}`),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: buildSubagentMessage(input),
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        })
        .pipe(
          Effect.as({ ok: true }),
          Effect.catch((cause) => Effect.succeed({ ok: false, message: errorText(cause) })),
        );
    });

  return SubagentControl.of({ transcript, stop, message });
});

export const layer = Layer.effect(SubagentControl, make);
