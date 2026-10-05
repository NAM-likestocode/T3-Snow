import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DeferService from "../../../defer/DeferService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DeferToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  // Optional so route harnesses that omit the service still build; calls then fail plainly.
  const deferOption = yield* Effect.serviceOption(DeferService.DeferService);

  return DeferToolkit.of({
    defer: (input) =>
      Effect.gen(function* () {
        // Every agent may schedule its own wake-ups; the credential already names the thread.
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
  });
});

export const DeferToolkitHandlersLive = DeferToolkit.toLayer(make);
