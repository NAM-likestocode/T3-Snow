/**
 * Helper profiles: named specialists a helper can run as (T3-Snow).
 *
 * A profile is a Markdown file with frontmatter (`name`, `description`,
 * `tools`, `model`, `effort`) whose body becomes extra instructions. Built-in
 * profiles ship here; `<T3 home>/agents/*.md` can add or replace them. Project
 * files (`.t3/agents`, `.claude/agents`, `.pi/agents`) add new names only and
 * are used only when asked for by name.
 *
 * @module helpers/helperProfiles
 */

export type HelperProfileSource = "built-in" | "user" | "project";

export interface HelperProfile {
  readonly name: string;
  readonly description: string;
  /** Tool names from the frontmatter, advisory only. Empty means all tools. */
  readonly tools: ReadonlyArray<string>;
  /** Pool model name to use when the caller names none. */
  readonly model: string | undefined;
  readonly effort: string | undefined;
  /** Extra instructions for the helper. */
  readonly instructions: string;
  /** Runs in plan mode so it cannot change files. */
  readonly readOnly: boolean;
  readonly source: HelperProfileSource;
}

export const DEFAULT_HELPER_PROFILE = "worker";

const EDITING_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "bash", "shell"]);

/** A profile that lists tools and none of them can edit or run commands is read-only. */
function isReadOnlyToolList(tools: ReadonlyArray<string>): boolean {
  return tools.length > 0 && !tools.some((tool) => EDITING_TOOLS.has(tool.toLowerCase()));
}

const WORKER: HelperProfile = {
  name: DEFAULT_HELPER_PROFILE,
  description: "General helper with the same tools and permissions as the thread that started it.",
  tools: [],
  model: undefined,
  effort: undefined,
  instructions: "",
  readOnly: false,
  source: "built-in",
};

export const BUILT_IN_HELPER_PROFILES: ReadonlyArray<HelperProfile> = [
  WORKER,
  {
    name: "scout",
    description:
      "Read-only. Quickly maps an unfamiliar or broad part of a codebase and says where things are.",
    tools: ["read", "grep", "glob", "ls"],
    model: undefined,
    effort: undefined,
    readOnly: true,
    source: "built-in",
    instructions: [
      "You are a scout. Map the part of the codebase the task is about, quickly and accurately. Do not change any files.",
      "Report with these headings:",
      "## Answer - the direct answer to the task.",
      "## Code map - the files and symbols that matter, with paths and one line each on their role.",
      "## Risks or unknowns - what you could not confirm.",
      "## Suggested next step",
    ].join("\n"),
  },
  {
    name: "reviewer",
    description:
      "Read-only. Independently checks a larger or riskier change for real bugs, missed requirements, and regressions.",
    tools: ["read", "grep", "glob", "ls"],
    model: undefined,
    effort: undefined,
    readOnly: true,
    source: "built-in",
    instructions: [
      "You are a reviewer. Check the change described in the task independently. Look for concrete bugs, missed requirements, and regressions, not style. Do not change any files.",
      "Report with these headings:",
      "## Verdict - ship, fix first, or rethink, in one line.",
      "## Findings - each with file:line, what is wrong, and why it matters. Most severe first.",
      "## Uncertainty - what you could not verify.",
    ].join("\n"),
  },
  {
    name: "researcher",
    description:
      "Web research. Answers questions that need several current web sources, with links.",
    tools: ["websearch", "webfetch"],
    model: undefined,
    effort: undefined,
    readOnly: true,
    source: "built-in",
    instructions: [
      "You are a researcher. Answer the question from current web sources. Prefer primary sources and link every load-bearing claim. Do not change any files.",
      "Report with these headings:",
      "## Answer",
      "## Key findings - bullets, each with a link.",
      "## Confidence - low, medium, or high, and why.",
      "## Sources used",
    ].join("\n"),
  },
];

/**
 * Parses one profile file. Returns undefined when the file has no usable
 * name. The name falls back to the file name without `.md`.
 */
export function parseHelperProfile(
  text: string,
  fileName: string,
  source: HelperProfileSource,
): HelperProfile | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields = new Map<string, string>();
  const body = match ? match[2]! : text;
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (field) fields.set(field[1]!.toLowerCase(), unquote(field[2]!.trim()));
    }
  }
  const name = (fields.get("name") || fileName.replace(/\.md$/i, "")).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return undefined;
  const tools = (fields.get("tools") ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tool) => unquote(tool.trim()))
    .filter((tool) => tool.length > 0);
  return {
    name,
    description: fields.get("description") ?? "",
    tools,
    model: fields.get("model") || undefined,
    effort: fields.get("effort") || fields.get("thinking") || undefined,
    instructions: body.trim(),
    readOnly: isReadOnlyToolList(tools),
    source,
  };
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Merges profile sources. User files replace built-ins of the same name,
 * except `worker`. Project files only add new names.
 */
export function mergeHelperProfiles(input: {
  readonly user: ReadonlyArray<HelperProfile>;
  readonly project: ReadonlyArray<HelperProfile>;
}): ReadonlyArray<HelperProfile> {
  const byName = new Map(BUILT_IN_HELPER_PROFILES.map((profile) => [profile.name, profile]));
  for (const profile of input.user) {
    if (profile.name !== DEFAULT_HELPER_PROFILE) byName.set(profile.name, profile);
  }
  for (const profile of input.project) {
    if (!byName.has(profile.name)) byName.set(profile.name, profile);
  }
  return [...byName.values()];
}
