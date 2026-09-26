/// <reference lib="webworker" />
/**
 * Runs Whisper on this device (T3-Snow voice dictation). Loads a quantized
 * model through Transformers.js + ONNX Runtime Web and transcribes 16 kHz mono
 * PCM sent from the page. Weights download once from Hugging Face and are
 * cached by the browser; nothing else leaves the machine.
 */
import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortWasmFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";

import type { WhisperWorkerRequest, WhisperWorkerResponse } from "./whisperProtocol";

// Serve the ONNX runtime from our own bundle rather than a CDN, so dictation
// works offline and inside the desktop app's content security policy.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortWasmFactoryUrl };
  env.backends.onnx.wasm.proxy = false;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

let loaded: {
  readonly repo: string;
  readonly transcriber: Promise<AutomaticSpeechRecognitionPipeline>;
} | null = null;

function post(message: WhisperWorkerResponse) {
  scope.postMessage(message);
}

function loadModel(repo: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (loaded?.repo === repo) return loaded.transcriber;
  const previous = loaded;
  // Per-file byte counts, so progress covers the whole model rather than
  // restarting for each weight file.
  const files = new Map<string, { loaded: number; total: number }>();
  const transcriber = (async () => {
    if (previous) {
      await previous.transcriber.then((pipe) => pipe.dispose()).catch(() => undefined);
    }
    const pipe = (await pipeline("automatic-speech-recognition", repo, {
      device: "wasm",
      dtype: "q8",
      progress_callback: (info: ProgressInfo) => {
        if (info.status !== "progress") return;
        files.set(info.file, { loaded: info.loaded, total: info.total });
        let loadedBytes = 0;
        let totalBytes = 0;
        for (const file of files.values()) {
          loadedBytes += file.loaded;
          totalBytes += file.total;
        }
        post({ type: "progress", repo, loaded: loadedBytes, total: totalBytes });
      },
    })) as AutomaticSpeechRecognitionPipeline;
    post({ type: "ready", repo });
    return pipe;
  })();
  loaded = { repo, transcriber };
  transcriber.catch((error: unknown) => {
    if (loaded?.transcriber === transcriber) loaded = null;
    post({ type: "load-error", repo, message: errorMessage(error) });
  });
  return transcriber;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "Whisper failed to run.";
}

scope.addEventListener("message", (event: MessageEvent<WhisperWorkerRequest>) => {
  const request = event.data;
  if (request.type === "load") {
    void loadModel(request.repo).catch(() => undefined);
    return;
  }
  void (async () => {
    try {
      const transcriber = await loadModel(request.repo);
      const output = await transcriber(request.audio, {
        // Whisper reads 30 s windows; striding stitches longer dictation.
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(request.multilingual
          ? { task: "transcribe", ...(request.language ? { language: request.language } : {}) }
          : {}),
      });
      const text = (Array.isArray(output) ? output : [output]).map((chunk) => chunk.text).join(" ");
      post({ type: "result", id: request.id, text: text.replace(/\s+/g, " ").trim() });
    } catch (error) {
      post({ type: "error", id: request.id, message: errorMessage(error) });
    }
  })();
});
