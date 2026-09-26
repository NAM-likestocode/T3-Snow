import type { VoiceModelId } from "@t3tools/contracts";

export interface WhisperModelInfo {
  readonly id: VoiceModelId;
  readonly label: string;
  /** Hugging Face repository with ONNX weights for Transformers.js. */
  readonly repo: string;
  /** Approximate one-time download for the quantized weights. */
  readonly sizeLabel: string;
  readonly multilingual: boolean;
  readonly description: string;
}

/**
 * Local Whisper models, smallest first. Every model runs on this device with
 * quantized (q8) weights through ONNX Runtime Web; the download happens once
 * and is cached by the browser.
 */
export const WHISPER_MODELS: Readonly<Record<VoiceModelId, WhisperModelInfo>> = {
  "tiny.en": {
    id: "tiny.en",
    label: "Tiny (English)",
    repo: "Xenova/whisper-tiny.en",
    sizeLabel: "≈40 MB",
    multilingual: false,
    description: "Fastest. Good for short, clear dictation.",
  },
  "base.en": {
    id: "base.en",
    label: "Base (English)",
    repo: "Xenova/whisper-base.en",
    sizeLabel: "≈80 MB",
    multilingual: false,
    description: "Recommended balance of speed and accuracy.",
  },
  "small.en": {
    id: "small.en",
    label: "Small (English)",
    repo: "Xenova/whisper-small.en",
    sizeLabel: "≈250 MB",
    multilingual: false,
    description: "Most accurate. Slower on older machines.",
  },
  base: {
    id: "base",
    label: "Base (Multilingual)",
    repo: "Xenova/whisper-base",
    sizeLabel: "≈80 MB",
    multilingual: true,
    description: "99 languages. Detects the spoken language automatically.",
  },
  small: {
    id: "small",
    label: "Small (Multilingual)",
    repo: "Xenova/whisper-small",
    sizeLabel: "≈250 MB",
    multilingual: true,
    description: "99 languages with better accuracy. Slower.",
  },
};

/** Common dictation languages for multilingual models. Empty means auto-detect. */
export const WHISPER_LANGUAGES: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];
