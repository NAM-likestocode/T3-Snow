import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceEngine, voiceRecordingMimeType } from "./voiceEngine";

describe("resolveVoiceEngine", () => {
  it("uses the chosen engine when it is usable, otherwise the other one", () => {
    const both = { deviceAvailable: true, deepgramAvailable: true };
    expect(resolveVoiceEngine({ preference: "deepgram", ...both })).toBe("deepgram");
    expect(resolveVoiceEngine({ preference: "device", ...both })).toBe("device");
    expect(resolveVoiceEngine({ preference: undefined, ...both })).toBe("device");
    expect(
      resolveVoiceEngine({ preference: "device", deviceAvailable: false, deepgramAvailable: true }),
    ).toBe("deepgram");
    expect(
      resolveVoiceEngine({
        preference: "deepgram",
        deviceAvailable: true,
        deepgramAvailable: false,
      }),
    ).toBe("device");
    expect(
      resolveVoiceEngine({
        preference: "deepgram",
        deviceAvailable: false,
        deepgramAvailable: false,
      }),
    ).toBeNull();
  });
});

describe("voiceRecordingMimeType", () => {
  it("names common recording formats and leaves unknown ones to the server", () => {
    expect(voiceRecordingMimeType("file:///cache/recording-1.m4a")).toBe("audio/mp4");
    expect(voiceRecordingMimeType("file:///cache/a.3GP")).toBe("audio/3gpp");
    expect(voiceRecordingMimeType("file:///cache/a.caf?x=1")).toBe("audio/x-caf");
    expect(voiceRecordingMimeType("file:///cache/recording")).toBe("");
  });
});
