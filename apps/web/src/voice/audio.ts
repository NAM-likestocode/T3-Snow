/** Whisper models expect 16 kHz mono PCM. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Averages every channel into one, the way Whisper expects its input. */
export function mixToMono(channels: ReadonlyArray<Float32Array>): Float32Array {
  const [first, ...rest] = channels;
  if (!first) return new Float32Array(0);
  if (rest.length === 0) return first;
  const mono = new Float32Array(first.length);
  for (const channel of channels) {
    for (let index = 0; index < mono.length; index += 1) {
      mono[index]! += channel[index] ?? 0;
    }
  }
  for (let index = 0; index < mono.length; index += 1) {
    mono[index]! /= channels.length;
  }
  return mono;
}

/** True when the clip holds nothing louder than background hiss. */
export function isSilent(samples: Float32Array, threshold = 0.01): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]!) > threshold) return false;
  }
  return true;
}

/** Decodes a recorded clip (webm/ogg/mp4) and resamples it to 16 kHz mono. */
export async function decodeRecordingForWhisper(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let index = 0; index < decoded.numberOfChannels; index += 1) {
      channels.push(decoded.getChannelData(index));
    }
    return mixToMono(channels);
  } finally {
    void context.close().catch(() => undefined);
  }
}

/** The first recorder format this browser supports, preferring Opus. */
export function pickRecordingMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function formatRecordingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function describeMicrophoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow T3 Code to use the microphone in your system settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Plug one in and try again.";
  }
  if (name === "NotReadableError") {
    return "The microphone is in use by another app.";
  }
  return error instanceof Error && error.message ? error.message : "Couldn't start recording.";
}

/** Base64 of a recorded clip, for sending it to the environment. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked so large clips don't overflow the argument limit of fromCharCode.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
