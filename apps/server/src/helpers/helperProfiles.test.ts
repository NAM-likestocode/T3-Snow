import { describe, expect, it } from "vite-plus/test";

import { mergeHelperProfiles, parseHelperProfile } from "./helperProfiles.ts";

describe("helper profiles", () => {
  it("parses frontmatter and treats a tool list without editing tools as read-only", () => {
    const profile = parseHelperProfile(
      '---\nname: Auditor\ndescription: "Checks licenses"\ntools: [read, grep]\nmodel: sonnet\neffort: high\n---\nList every license.\n',
      "whatever.md",
      "user",
    );
    expect(profile).toEqual({
      name: "auditor",
      description: "Checks licenses",
      tools: ["read", "grep"],
      model: "sonnet",
      effort: "high",
      instructions: "List every license.",
      readOnly: true,
      source: "user",
    });
    expect(parseHelperProfile("---\ntools: read, edit\n---\nx", "fixer.md", "user")).toMatchObject({
      name: "fixer",
      readOnly: false,
    });
    expect(parseHelperProfile("Just a body", "Plain.md", "project")).toMatchObject({
      name: "plain",
      tools: [],
      readOnly: false,
    });
    expect(parseHelperProfile("x", "bad name!.md", "user")).toBeUndefined();
  });

  it("lets user files replace built-ins except worker, and project files only add names", () => {
    const user = [
      parseHelperProfile("---\ndescription: mine\n---\n", "scout.md", "user")!,
      parseHelperProfile("---\ndescription: hijack\n---\n", "worker.md", "user")!,
    ];
    const project = [
      parseHelperProfile("---\ndescription: project scout\n---\n", "scout.md", "project")!,
      parseHelperProfile("---\ndescription: docs\n---\n", "docs.md", "project")!,
    ];
    const merged = mergeHelperProfiles({ user, project });
    const byName = new Map(merged.map((profile) => [profile.name, profile]));
    expect(byName.get("worker")?.source).toBe("built-in");
    expect(byName.get("scout")?.description).toBe("mine");
    expect(byName.get("docs")?.source).toBe("project");
    expect([...byName.keys()]).toEqual(["worker", "scout", "reviewer", "researcher", "docs"]);
  });
});
