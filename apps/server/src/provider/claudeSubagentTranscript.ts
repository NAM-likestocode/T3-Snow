// @effect-diagnostics preferSchemaOverJson:off - transcript lines are tolerant best-effort reads of an external format.
/**
 * Reads a Claude subagent transcript (T3-Snow): the JSONL file Claude Code
 * writes at `<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`,
 * turned into short entries for the Agents panel.
 *
 * @module provider/claudeSubagentTranscript
 */
import type { SubagentTranscriptEntry } from "@t3tools/contracts";

export const TRANSCRIPT_MAX_ENTRIES = 300;
const TEXT_LIMIT = 4_000;
const TOOL_INPUT_LIMIT = 600;
const TOOL_RESULT_LIMIT = 1_500;

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** The most telling part of a tool call's input, e.g. a command or a path. */
function describeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, TOOL_INPUT_LIMIT);
  }
  try {
    return clip(JSON.stringify(input), TOOL_INPUT_LIMIT);
  } catch {
    return "";
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Parses the JSONL text; unreadable lines are skipped. */
export function parseClaudeSubagentTranscript(jsonl: string): {
  readonly entries: ReadonlyArray<SubagentTranscriptEntry>;
  readonly omitted: number;
} {
  const entries: SubagentTranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const content = record.message?.content;
    if (typeof content === "string") {
      if (content.trim()) {
        entries.push({
          kind: record.type === "user" ? "prompt" : "text",
          text: clip(content, TEXT_LIMIT),
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as ReadonlyArray<Record<string, unknown>>) {
      switch (block?.type) {
        case "text":
          if (typeof block.text === "string" && block.text.trim()) {
            entries.push({
              kind: record.type === "user" ? "prompt" : "text",
              text: clip(block.text, TEXT_LIMIT),
            });
          }
          break;
        case "thinking":
          if (typeof block.thinking === "string" && block.thinking.trim()) {
            entries.push({ kind: "thinking", text: clip(block.thinking, TEXT_LIMIT) });
          }
          break;
        case "tool_use":
          entries.push({
            kind: "tool",
            toolName: typeof block.name === "string" ? block.name : "tool",
            text: describeToolInput(block.input),
          });
          break;
        case "tool_result": {
          const text = resultText(block.content);
          if (text.trim())
            entries.push({ kind: "tool-result", text: clip(text, TOOL_RESULT_LIMIT) });
          break;
        }
        default:
          break;
      }
    }
  }
  const omitted = Math.max(0, entries.length - TRANSCRIPT_MAX_ENTRIES);
  return { entries: omitted > 0 ? entries.slice(omitted) : entries, omitted };
}
