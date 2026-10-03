import * as Schema from "effect/Schema";

/**
 * T3-Snow voice dictation. Whisper runs on the client device, so the only
 * shared contract is which local model a device prefers. The web client owns
 * the model catalog (download locations, sizes, labels).
 */
export const VOICE_MODEL_IDS = ["tiny.en", "base.en", "small.en", "base", "small"] as const;
export const VoiceModelId = Schema.Literals(VOICE_MODEL_IDS);
export type VoiceModelId = typeof VoiceModelId.Type;
export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = "base.en";

/**
 * Where dictation is transcribed: `local` runs Whisper on this device;
 * `deepgram` sends the recording to the environment, which calls Deepgram
 * with the API key stored in its secret store.
 */
export const VoiceEngine = Schema.Literals(["local", "deepgram"]);
export type VoiceEngine = typeof VoiceEngine.Type;

export const VoiceStatus = Schema.Struct({
  deepgramKeySet: Schema.Boolean,
  /** Set when saving or removing the key failed. */
  message: Schema.optional(Schema.String),
});
export type VoiceStatus = typeof VoiceStatus.Type;

export const VoiceSetDeepgramKeyInput = Schema.Struct({
  /** Null removes the stored key. */
  apiKey: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
});
export type VoiceSetDeepgramKeyInput = typeof VoiceSetDeepgramKeyInput.Type;

/** Base64 audio is capped near 20 MB; a 10-minute Opus clip is about 5 MB. */
export const VOICE_MAX_AUDIO_BASE64_LENGTH = 20_000_000;

export const VoiceTranscribeInput = Schema.Struct({
  audioBase64: Schema.String.check(Schema.isMaxLength(VOICE_MAX_AUDIO_BASE64_LENGTH)),
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  /** ISO-639-1 code; empty detects the language. */
  language: Schema.String.check(Schema.isMaxLength(16)),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  /** Null when transcription failed; `message` says why. */
  text: Schema.NullOr(Schema.String),
  message: Schema.optional(Schema.String),
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;
