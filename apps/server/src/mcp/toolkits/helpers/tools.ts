import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HelperService from "../../../helpers/HelperService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Parameters follow the Pi `subagent` tool so existing prompts carry over. */
export const SubagentToolInput = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["start", "list", "stop"]).annotate({
      description:
        "start (default) runs a helper; list shows helpers, profiles and models; stop ends one (id) or all (id: 'all').",
    }),
  ),
  task: Schema.optional(
    Schema.String.annotate({
      description:
        "Self-contained task with paths, commands and acceptance criteria. The helper cannot see this conversation.",
    }),
  ),
  reason: Schema.optional(
    Schema.String.annotate({ description: "One sentence on why delegating is worthwhile." }),
  ),
  agent: Schema.optional(
    Schema.String.annotate({
      description: "Profile: worker (default, full tools), scout, reviewer, researcher, or custom.",
    }),
  ),
  name: Schema.optional(Schema.String.annotate({ description: "Short label for this helper." })),
  mode: Schema.optional(
    Schema.Literals(["background", "wait"]).annotate({
      description:
        "background (default) returns now and the report arrives later as a message; wait returns the report if it is ready within 50s.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "Model name, e.g. opus or gpt-6-astra. Omit to use the helper model from settings.",
    }),
  ),
  effort: Schema.optional(
    Schema.String.annotate({ description: "Reasoning effort, e.g. low, medium, high." }),
  ),
  instructions: Schema.optional(
    Schema.String.annotate({ description: "Extra instructions for the helper." }),
  ),
  id: Schema.optional(Schema.String.annotate({ description: "Helper id, for stop." })),
});
export type SubagentToolInput = typeof SubagentToolInput.Type;

export const SubagentToolError = Schema.Union([
  McpCapabilityUnavailableError,
  HelperService.HelperRequestError,
]);

const SubagentTool = Tool.make("subagent", {
  description:
    'Hand a bounded task to a helper: another agent that runs in its own T3 Code thread, on any configured model, with this thread\'s permissions (scout, reviewer and researcher are read-only). By default it runs in the background and its report arrives as a new message in this thread, beginning with [Helper "<name>" …], after any running turn finishes. Do not wait or poll for it: keep working, or end your turn.',
  parameters: SubagentToolInput,
  success: Schema.String,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Helper")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HelpersToolkit = Toolkit.make(SubagentTool);
