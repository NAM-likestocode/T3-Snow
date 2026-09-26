import { describe, expect, it } from "vite-plus/test";

import { formatRecordingDuration, isSilent, mixToMono } from "./audio";

describe("mixToMono", () => {
  it("returns a single channel unchanged", () => {
    const channel = new Float32Array([0.1, -0.2]);
    expect(mixToMono([channel])).toBe(channel);
  });

  it("averages stereo channels", () => {
    const mono = mixToMono([new Float32Array([1, 0]), new Float32Array([0, -1])]);
    expect(Array.from(mono)).toEqual([0.5, -0.5]);
  });

  it("handles a clip with no channels", () => {
    expect(mixToMono([]).length).toBe(0);
  });
});

describe("isSilent", () => {
  it("treats hiss as silence and speech as sound", () => {
    expect(isSilent(new Float32Array([0.001, -0.004]))).toBe(true);
    expect(isSilent(new Float32Array([0.001, 0.3]))).toBe(false);
  });
});

describe("formatRecordingDuration", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatRecordingDuration(0)).toBe("0:00");
    expect(formatRecordingDuration(7_900)).toBe("0:07");
    expect(formatRecordingDuration(125_000)).toBe("2:05");
  });
});
