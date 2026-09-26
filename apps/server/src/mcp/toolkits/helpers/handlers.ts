import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HelperService from "../../../helpers/HelperService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HelpersToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  // Optional so route harnesses that omit the service still build; calls then fail plainly.
  const helpersOption = yield* Effect.serviceOption(HelperService.HelperService);

  return HelpersToolkit.of({
    subagent: (input) =>
      Effect.gen(function* () {
        // The credential names the calling thread, so an agent only sees and stops its own helpers.
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (Option.isNone(helpersOption)) {
          return yield* new HelperService.HelperRequestError({
            detail: "helpers are not available on this T3 Code server",
          });
        }
        const helpers = helpersOption.value;
        switch (input.action ?? "start") {
          case "list":
            return yield* helpers.list(scope.threadId);
          case "stop":
            return yield* helpers.stop(scope.threadId, input.id ?? "");
          case "start":
            return yield* helpers.start({
              threadId: scope.threadId,
              task: input.task ?? "",
              reason: input.reason,
              agent: input.agent,
              name: input.name,
              mode: input.mode,
              model: input.model,
              effort: input.effort,
              instructions: input.instructions,
            });
        }
      }),
  });
});

export const HelpersToolkitHandlersLive = HelpersToolkit.toLayer(make);
