#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a tiny synchronous text rewrite, run by hand and in CI.
// @effect-diagnostics globalConsole:off - prints a one-line CLI result.
// T3-Snow: keeps upstream's GitHub workflows from running in this fork.
//
// Upstream workflows target pingdotgg/t3code's Blacksmith runners, secrets, and
// deploy targets. Every job in a non-`snow-` workflow gets
// `github.repository == 'pingdotgg/t3code'` added to its `if`, so the files
// stay byte-for-byte mergeable with upstream except for that one guard.
// Idempotent: jobs that already carry the guard are left alone.
//
// Usage: node scripts/snow/guard-upstream-workflows.ts [--check]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const GUARD = "github.repository == 'pingdotgg/t3code'";
const WORKFLOWS_DIR = NodePath.join(import.meta.dirname, "../../.github/workflows");

export function guardWorkflow(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let inJobs = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    out.push(line);
    if (line.startsWith("jobs:")) {
      inJobs = true;
      index += 1;
      continue;
    }
    if (inJobs && /^[^\s#]/.test(line)) inJobs = false;
    if (!inJobs || !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      index += 1;
      continue;
    }

    // Find this job's `if:` among its 4-space keys.
    let cursor = index + 1;
    let ifIndex = -1;
    while (
      cursor < lines.length &&
      (lines[cursor]!.startsWith("    ") || lines[cursor]!.trim() === "")
    ) {
      if (/^ {4}if:/.test(lines[cursor]!)) {
        ifIndex = cursor;
        break;
      }
      cursor += 1;
    }

    if (ifIndex === -1) {
      out.push(`    if: ${GUARD}`);
      index += 1;
      continue;
    }
    for (let copy = index + 1; copy < ifIndex; copy += 1) out.push(lines[copy]!);
    const ifLine = lines[ifIndex]!;
    const value = ifLine.slice("    if:".length).trim();

    if (["|", "|-", ">", ">-"].includes(value)) {
      const body: string[] = [];
      let next = ifIndex + 1;
      while (next < lines.length && lines[next]!.startsWith("      ")) {
        body.push(lines[next]!);
        next += 1;
      }
      out.push(ifLine);
      if (body[0]?.includes(GUARD)) {
        out.push(...body);
      } else {
        out.push(`      ${GUARD} && (`, ...body, "      )");
      }
      index = next;
      continue;
    }

    if (value.includes(GUARD)) {
      out.push(ifLine);
    } else {
      const expression = value.match(/^\$\{\{\s*(.*?)\s*\}\}$/)?.[1] ?? value;
      out.push(`    if: \${{ ${GUARD} && (${expression}) }}`);
    }
    index = ifIndex + 1;
  }
  return out.join("\n");
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const unguarded: string[] = [];
  for (const name of NodeFS.readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(name) || name.startsWith("snow-")) continue;
    const filePath = NodePath.join(WORKFLOWS_DIR, name);
    const source = NodeFS.readFileSync(filePath, "utf8");
    const guarded = guardWorkflow(source);
    if (guarded === source) continue;
    unguarded.push(name);
    if (!check) NodeFS.writeFileSync(filePath, guarded);
  }
  if (check && unguarded.length > 0) {
    console.error(`Unguarded upstream workflows: ${unguarded.join(", ")}`);
    process.exit(1);
  }
  console.log(
    unguarded.length === 0
      ? "All upstream workflows are guarded."
      : `Guarded: ${unguarded.join(", ")}`,
  );
}
