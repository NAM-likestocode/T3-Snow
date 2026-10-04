/**
 * T3-Snow: which transcriber mobile dictation uses. "device" is the phone's
 * own engine (iOS on-device); "deepgram" sends the recording to the connected
 * T3 Code server, which transcribes it with its Deepgram key.
 */
export type MobileVoiceEngine = "device" | "deepgram";

/** The chosen engine when it is usable, else whichever one is. */
export function resolveVoiceEngine(input: {
  readonly preference: MobileVoiceEngine | undefined;
  readonly deviceAvailable: boolean;
  readonly deepgramAvailable: boolean;
}): MobileVoiceEngine | null {
  if (input.preference === "deepgram" && input.deepgramAvailable) return "deepgram";
  if (input.preference === "device" && input.deviceAvailable) return "device";
  if (input.deviceAvailable) return "device";
  if (input.deepgramAvailable) return "deepgram";
  return null;
}

/** The audio type the server should declare for a recording, from its file name. */
export function voiceRecordingMimeType(uri: string): string {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri)?.[1]?.toLowerCase();
  switch (extension) {
    case "m4a":
    case "mp4":
    case "aac":
      return "audio/mp4";
    case "3gp":
      return "audio/3gpp";
    case "webm":
      return "audio/webm";
    case "wav":
      return "audio/wav";
    case "caf":
      return "audio/x-caf";
    default:
      return "";
  }
}
