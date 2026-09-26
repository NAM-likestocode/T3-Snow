/** Messages between the page and `whisper.worker.ts`. */
export type WhisperWorkerRequest =
  | { readonly type: "load"; readonly repo: string }
  | {
      readonly type: "transcribe";
      readonly id: number;
      readonly repo: string;
      readonly multilingual: boolean;
      readonly language: string;
      /** 16 kHz mono PCM. */
      readonly audio: Float32Array;
    };

export type WhisperWorkerResponse =
  | {
      readonly type: "progress";
      readonly repo: string;
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly type: "ready"; readonly repo: string }
  | { readonly type: "load-error"; readonly repo: string; readonly message: string }
  | { readonly type: "result"; readonly id: number; readonly text: string }
  | { readonly type: "error"; readonly id: number; readonly message: string };
