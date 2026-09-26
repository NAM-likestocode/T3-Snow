import type { DeferTrigger } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deferTriggerState,
  describeDeferStatus,
  formatDeferDuration,
} from "./ComposerDeferBanner.logic";

const base: DeferTrigger = {
  id: "dk3x9q",
  threadId: ThreadId.make("thread-1"),
  kind: "at",
  note: "check the deploy",
  armedAt: "2026-09-26T14:00:00.000Z",
  firesAt: "2026-09-26T14:30:00.000Z",
  checks: 0,
  lastExit: null,
};
const now = Date.parse("2026-09-26T14:00:12.000Z");

describe("ComposerDeferBanner logic", () => {
  it("counts down time triggers", () => {
    expect(describeDeferStatus(base, now)).toBe("in 29m48s");
    expect(deferTriggerState(base)).toBe("time");
  });

  it("summarizes condition triggers and flags a broken check", () => {
    const checking: DeferTrigger = {
      ...base,
      kind: "check",
      check: "gh run view",
      checks: 12,
      lastExit: 1,
    };
    expect(describeDeferStatus(checking, now)).toBe("12× · exit 1 · 29m48s left");
    expect(deferTriggerState(checking)).toBe("checking");
    expect(deferTriggerState({ ...checking, lastExit: 127 })).toBe("broken");
    expect(deferTriggerState({ ...checking, checks: 0, lastExit: null })).toBe("pending");
  });

  it("formats compact durations", () => {
    expect(formatDeferDuration(45_000)).toBe("45s");
    expect(formatDeferDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h05m");
    expect(formatDeferDuration(76 * 3_600_000)).toBe("3d4h");
    expect(formatDeferDuration(-5_000)).toBe("0s");
  });
});
