import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface AgentToolStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The tool calls a native subagent made, oldest first, from the thread's
 * tool.* activities (Claude tags each with the owning subagent's task id).
 * One step per tool call: a completion replaces its start.
 */
export function deriveAgentToolSteps(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  taskId: string,
): ReadonlyArray<AgentToolStep> {
  const steps = new Map<string, AgentToolStep>();
  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = (activity.payload ?? {}) as Record<string, unknown>;
    if (payload.agentId !== taskId) continue;
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const key = asString(payload.toolCallId) ?? activity.id;
    steps.set(key, {
      id: key,
      title: asString(data.toolName) ?? asString(payload.title) ?? activity.summary,
      detail: asString(payload.detail),
    });
  }
  return [...steps.values()];
}
