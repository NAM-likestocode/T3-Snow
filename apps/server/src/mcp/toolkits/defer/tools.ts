import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DeferService from "../../../defer/DeferService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Parameters and descriptions match the Pi `defer` tool so existing prompts carry over. */
export const DeferToolInput = Schema.Struct({
  action: Schema.Literals(["create", "list", "cancel"]),
  note: Schema.optional(
    Schema.String.annotate({
      description:
        "What to do when this fires. It arrives with no other context, so make it self-contained.",
    }),
  ),
  at: Schema.optional(
    Schema.String.annotate({
      description:
        "'2am', '14:30', 'in 30m', or an ISO timestamp. With `check`, this is the deadline (the check-in time).",
    }),
  ),
  check: Schema.optional(
    Schema.String.annotate({ description: "Shell command polled until it exits 0" }),
  ),
  run: Schema.optional(
    Schema.String.annotate({ description: "Command to run at fire time; its output wakes you" }),
  ),
  pollMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String.annotate({ description: "Trigger id, for cancel" })),
});
export type DeferToolInput = typeof DeferToolInput.Type;

export const DeferToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DeferService.DeferRequestError,
]);

const DeferTool = Tool.make("defer", {
  description:
    "Schedule a wake-up. Fire at a time ('2am', 'in 30m', ISO), or as soon as a shell command exits 0, optionally running a command at fire time and waking you with its output. Use instead of sleeping or polling in bash: arm it and keep working, or end your turn. The wake-up arrives as a new message in this thread after any running turn finishes. Commands run in Git Bash on Windows (PowerShell if Git Bash is missing) and bash elsewhere, in this thread's working directory. Triggers last until T3 Code restarts; one that is lost to a restart is reported to you.",
  parameters: DeferToolInput,
  success: Schema.String,
  failure: DeferToolError,
  dependencies,
})
  .annotate(Tool.Title, "Defer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const DeferToolkit = Toolkit.make(DeferTool);
