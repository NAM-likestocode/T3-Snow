import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DeferService from "../../../defer/DeferService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeferToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  // Optional so route harnesses that omit the service still build; calls then fail plainly.
  const deferOption = yield* Effect.serviceOption(DeferService.DeferService);

  return {
    // A wake-up belongs to the calling thread, so only an agent running inside one may arm it.
    defer: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (!scope.thread) {
          return yield* new DeferService.DeferRequestError({
            detail: "defer wakes a thread's agent, so it is only available inside a thread",
          });
        }
        const threadId = scope.thread.threadId;
        if (Option.isNone(deferOption)) {
          return yield* new DeferService.DeferRequestError({
            detail: "defer is not available on this T3 Code server",
          });
        }
        const defer = deferOption.value;
        switch (input.action) {
          case "create":
            return yield* defer.create({
              threadId,
              note: input.note,
              at: input.at,
              check: input.check,
              run: input.run,
              pollMs: input.pollMs,
              timeoutMs: input.timeoutMs,
            });
          case "list":
            return yield* defer.list(threadId);
          case "cancel":
            return yield* defer.cancel(threadId, input.id ?? "");
        }
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof DeferToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(DeferToolkit, make);
