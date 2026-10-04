import type { VoiceTranscribeInput, VoiceTranscribeResult } from "@t3tools/contracts";
import { File } from "expo-file-system";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { voiceRecordingMimeType } from "../features/voice-input/voiceEngine";

/**
 * T3-Snow: transcribes on the connected T3 Code server with its Deepgram key,
 * so the key never lives on the phone. The language is detected by Deepgram.
 */
export function createServerVoiceTranscriber(
  transcribe: (input: VoiceTranscribeInput) => Promise<VoiceTranscribeResult>,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          let result: VoiceTranscribeResult;
          try {
            const audioBase64 = await new File(uri).base64();
            throwIfVoiceTranscriptionAborted(options.signal);
            result = await transcribe({
              audioBase64,
              mimeType: voiceRecordingMimeType(uri),
              language: "",
            });
          } catch (error) {
            throwIfVoiceTranscriptionAborted(options.signal);
            if (error instanceof VoiceTranscriptionError) throw error;
            // The server's own failures (no key, rejected key) are worded for the user.
            throw new VoiceTranscriptionError(
              "transcription-failed",
              error instanceof Error && error.message ? error.message : "Transcription failed.",
              { cause: error, userFacing: error instanceof Error && error.message.length > 0 },
            );
          }
          throwIfVoiceTranscriptionAborted(options.signal);
          if (result.text === null) {
            throw new VoiceTranscriptionError(
              "transcription-failed",
              result.message ?? "Voice transcription failed.",
              { userFacing: result.message !== undefined },
            );
          }
          return result.text;
        },
      };
    },
  };
}
