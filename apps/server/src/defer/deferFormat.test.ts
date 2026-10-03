// @effect-diagnostics globalDate:off - fixtures are local wall-clock times.
import { describe, expect, it } from "vite-plus/test";

import {
  buildDeferWakeMessage,
  formatCompactDuration,
  makeDeferTriggerId,
  parseDeferTime,
  trimDeferOutput,
} from "./deferFormat.ts";

// 2026-09-26 14:02:10 local time.
const now = new Date(2026, 8, 26, 14, 2, 10);

describe("parseDeferTime", () => {
  it("adds relative offsets", () => {
    expect(parseDeferTime("in 30m", now)?.getTime()).toBe(now.getTime() + 30 * 60_000);
    expect(parseDeferTime("in 45s", now)?.getTime()).toBe(now.getTime() + 45_000);
    expect(parseDeferTime("in 1.5h", now)?.getTime()).toBe(now.getTime() + 90 * 60_000);
    expect(parseDeferTime("in 2 days", now)?.getTime()).toBe(now.getTime() + 2 * 86_400_000);
  });

  it("reads clock times today, or tomorrow once passed", () => {
    expect(parseDeferTime("14:30", now)).toEqual(new Date(2026, 8, 26, 14, 30));
    expect(parseDeferTime("2:15pm", now)).toEqual(new Date(2026, 8, 26, 14, 15));
    expect(parseDeferTime("2am", now)).toEqual(new Date(2026, 8, 27, 2, 0));
    expect(parseDeferTime("9", now)).toEqual(new Date(2026, 8, 27, 9, 0));
    expect(parseDeferTime("12am", now)).toEqual(new Date(2026, 8, 27, 0, 0));
    expect(parseDeferTime("12pm", now)).toEqual(new Date(2026, 8, 27, 12, 0));
  });

  it("falls back to Date.parse and rejects nonsense", () => {
    expect(parseDeferTime("2026-09-27T09:00:00", now)).toEqual(new Date(2026, 8, 27, 9, 0));
    expect(parseDeferTime("tomorrow 9am", now)).toBeNull();
    expect(parseDeferTime("in 5 fortnights", now)).toBeNull();
    expect(parseDeferTime("25:00", now)).toBeNull();
  });
});

describe("formatCompactDuration", () => {
  it("uses compact units", () => {
    expect(formatCompactDuration(45_000)).toBe("45s");
    expect(formatCompactDuration(252_000)).toBe("4m12s");
    expect(formatCompactDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h05m");
    expect(formatCompactDuration(3_600_000)).toBe("1h");
    expect(formatCompactDuration(76 * 3_600_000)).toBe("3d4h");
  });
});

describe("trimDeferOutput", () => {
  it("keeps the head and tail of long output", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const { text, clipped } = trimDeferOutput(lines);
    expect(clipped).toBe(true);
    expect(text.split("\n")).toHaveLength(41);
    expect(text).toContain("line 28\n… 60 lines omitted …\nline 89");
    expect(text.endsWith("line 100")).toBe(true);
  });

  it("caps characters", () => {
    const { text, clipped } = trimDeferOutput("x".repeat(5_000));
    expect(clipped).toBe(true);
    expect(text.endsWith("… truncated at 4000 characters …")).toBe(true);
  });

  it("leaves short output alone", () => {
    expect(trimDeferOutput("ok\n")).toEqual({ text: "ok", clipped: false });
  });
});

describe("buildDeferWakeMessage", () => {
  it("formats a condition wake-up with run output", () => {
    expect(
      buildDeferWakeMessage({
        id: "dk3x9q",
        reason: { kind: "condition", check: "test -f done", afterMs: 252_000 },
        note: "Build finished: read build.log",
        run: { command: "tail build.log", exitCode: 0, output: "" },
      }),
    ).toBe(
      "dk3x9q fired: `test -f done` held after 4m12s\nBuild finished: read build.log\n\n$ tail build.log (exit 0)\n(no output)",
    );
  });

  it("reports a timeout that gave up", () => {
    expect(
      buildDeferWakeMessage({
        id: "dp0w2a",
        reason: { kind: "timeout", afterMs: 3_600_000, checks: 240, lastExit: 1 },
        note: "review CI",
      }),
    ).toBe("dp0w2a fired: gave up after 1h, 240 checks, last exit 1\nreview CI");
  });
});

describe("makeDeferTriggerId", () => {
  it("makes d plus five characters", () => {
    expect(makeDeferTriggerId(() => 0)).toBe("daaaaa");
    expect(makeDeferTriggerId()).toMatch(/^d[a-z0-9]{5}$/);
  });
});
