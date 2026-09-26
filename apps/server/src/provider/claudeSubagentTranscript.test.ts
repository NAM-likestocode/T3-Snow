import { describe, expect, it } from "vite-plus/test";

import { parseClaudeSubagentTranscript } from "./claudeSubagentTranscript.ts";

const line = (value: unknown) => JSON.stringify(value);

describe("parseClaudeSubagentTranscript", () => {
  it("turns prompts, text, thinking, tool calls and results into entries", () => {
    const jsonl = [
      line({ type: "user", message: { content: "Map the auth module" } }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Start with the routes." },
            { type: "text", text: "Looking around." },
            { type: "tool_use", name: "Bash", input: { command: "ls src", description: "x" } },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: [{ type: "text", text: "auth.ts" }] }],
        },
      }),
      "not json",
      line({ type: "system", message: { content: "ignored" } }),
    ].join("\n");
    expect(parseClaudeSubagentTranscript(jsonl)).toEqual({
      entries: [
        { kind: "prompt", text: "Map the auth module" },
        { kind: "thinking", text: "Start with the routes." },
        { kind: "text", text: "Looking around." },
        { kind: "tool", toolName: "Bash", text: "ls src" },
        { kind: "tool-result", text: "auth.ts" },
      ],
      omitted: 0,
    });
  });

  it("keeps only the newest entries of a long transcript", () => {
    const jsonl = Array.from({ length: 305 }, (_, index) =>
      line({ type: "assistant", message: { content: `step ${index}` } }),
    ).join("\n");
    const parsed = parseClaudeSubagentTranscript(jsonl);
    expect(parsed.omitted).toBe(5);
    expect(parsed.entries[0]).toEqual({ kind: "text", text: "step 5" });
  });
});
