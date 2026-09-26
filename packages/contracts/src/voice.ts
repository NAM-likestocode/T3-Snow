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
