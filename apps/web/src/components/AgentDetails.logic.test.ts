import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentToolSteps } from "./AgentDetails.logic";

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({ id, kind, summary: kind, payload, tone: "tool", turnId: null, createdAt: "" }) as never;

describe("deriveAgentToolSteps", () => {
  it("keeps one step per tool call for the given subagent, in order", () => {
    const steps = deriveAgentToolSteps(
      [
        activity("1", "tool.started", {
          agentId: "a1",
          toolCallId: "t1",
          data: { toolName: "Bash" },
        }),
        activity("2", "tool.started", {
          agentId: "other",
          toolCallId: "t2",
          data: { toolName: "Read" },
        }),
        activity("3", "tool.completed", {
          agentId: "a1",
          toolCallId: "t1",
          detail: "ls src",
          data: { toolName: "Bash" },
        }),
        activity("4", "tool.started", { agentId: "a1", toolCallId: "t3", title: "Edit" }),
        activity("5", "task.progress", { agentId: "a1" }),
      ],
      "a1",
    );
    expect(steps).toEqual([
      { id: "t1", title: "Bash", detail: "ls src" },
      { id: "t3", title: "Edit", detail: null },
    ]);
  });
});
