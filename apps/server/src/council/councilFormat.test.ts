import { describe, expect, it } from "vite-plus/test";

import {
  buildCouncilConfirmation,
  buildCouncilReport,
  buildScoreLine,
  extractScore,
  parseCouncilArgs,
  splitModelEffort,
} from "./councilFormat.ts";

describe("council format", () => {
  it("parses flags, rounds, and the optional model word", () => {
    expect(parseCouncilArgs("opus5max --rounds 3 --no-web A dog-walking app", 2, true)).toEqual({
      kind: "run",
      modelToken: "opus5max",
      rounds: 3,
      web: false,
      idea: "A dog-walking app",
      ideaWithModelToken: "opus5max A dog-walking app",
    });
    expect(parseCouncilArgs("--quick Sell soup online", 2, true)).toMatchObject({
      rounds: 1,
      web: true,
    });
    expect(parseCouncilArgs("help", 2, true)).toEqual({ kind: "help" });
    expect(parseCouncilArgs("models", 2, true)).toEqual({ kind: "models" });
    expect(parseCouncilArgs("hi", 2, true)).toEqual({
      kind: "error",
      message: "Describe the idea in a sentence or two.",
    });
    expect(parseCouncilArgs("--rounds 7 x", 2, true)).toMatchObject({ kind: "error" });
  });

  it("splits an effort suffix off a model name", () => {
    expect(splitModelEffort("opus5max")).toEqual({ model: "opus5", effort: "max" });
    expect(splitModelEffort("opus5:xhigh")).toEqual({ model: "opus5", effort: "xhigh" });
    expect(splitModelEffort("gpt-6-astra-high")).toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(splitModelEffort("sonnet5")).toEqual({ model: "sonnet5", effort: undefined });
  });

  it("takes the last score and builds the score line", () => {
    expect(extractScore("score: 4/10 at first … **Updated verdict** score: 6/10")).toBe(6);
    expect(extractScore("`score: 7.5 / 10`")).toBe(7.5);
    expect(extractScore("no verdict")).toBeNull();
    expect(
      buildScoreLine([
        { short: "Optimist", score: 8 },
        { short: "Skeptic", score: 4 },
        { short: "CFO", score: 6 },
        { short: "Operator", score: 7 },
      ]),
    ).toBe("Council score 6.3/10 — Optimist 8 · Skeptic 4 · CFO 6 · Operator 7");
  });

  it("puts the chair's verdict before the debate and lists notes", () => {
    const report = buildCouncilReport({
      idea: "Sell soup online",
      model: "claude-opus-5-5:high",
      web: true,
      rounds: [
        {
          label: "Opening statements",
          answers: [
            { memberId: "optimist", text: "Great. score: 8/10", error: null },
            { memberId: "skeptic", text: null, error: "Timed out." },
          ],
        },
        { label: "Debate round 1", answers: [], skippedNote: "Skipped." },
      ],
      chair: { text: "## Verdict\n**Not smart**", error: null },
      notes: ["The Skeptic: opening failed — Timed out."],
      durationMs: 125_000,
      runs: 5,
    });
    expect(report.indexOf("## Verdict")).toBeLessThan(report.indexOf("# Full debate"));
    expect(report).toContain("**Council score 8.0/10 — Optimist 8**");
    expect(report).toContain("### ☀ The Optimist — 8/10");
    expect(report).toContain("### ☁ The Skeptic\n\n_Timed out._");
    expect(report).toContain("_Skipped._");
    expect(report).toContain("_5 model runs · 2m05s_");
  });

  it("confirms with the run count and web warning", () => {
    expect(
      buildCouncilConfirmation({
        idea: "Sell soup online",
        seats: [{ name: "☀ Optimist", model: "opus" }],
        rounds: 2,
        web: true,
      }),
    ).toBe(
      "Convene the council?\nIdea: Sell soup online\n☀ Optimist: opus\nRounds: 2 (+ chair) → 9 model runs\nWeb research: ON — your idea text is sent to the search provider\nThis runs several full model sessions and costs real tokens.",
    );
  });
});
