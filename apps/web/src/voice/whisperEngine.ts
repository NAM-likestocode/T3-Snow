import type { VoiceModelId } from "@t3tools/contracts";
import { create } from "zustand";

import { WHISPER_MODELS } from "./whisperModels";
import type { WhisperWorkerRequest, WhisperWorkerResponse } from "./whisperProtocol";

/** Transformers.js keeps downloaded weights in this Cache Storage bucket. */
const TRANSFORMERS_CACHE_NAME = "transformers-cache";

export type WhisperModelStatus =
  | { readonly state: "downloading"; readonly progress: number | null }
  | { readonly state: "ready" }
  | { readonly state: "error"; readonly message: string };

interface WhisperStore {
  readonly statusByRepo: Readonly<Record<string, WhisperModelStatus>>;
}

export const useWhisperStore = create<WhisperStore>(() => ({ statusByRepo: {} }));

function setStatus(repo: string, status: WhisperModelStatus | null) {
  useWhisperStore.setState((state) => {
    const next = { ...state.statusByRepo };
    if (status) next[repo] = status;
    else delete next[repo];
    return { statusByRepo: next };
  });
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<
  number,
  { readonly resolve: (text: string) => void; readonly reject: (error: Error) => void }
>();

function handleMessage(message: WhisperWorkerResponse) {
  switch (message.type) {
    case "progress":
      setStatus(message.repo, {
        state: "downloading",
        progress: message.total > 0 ? Math.min(1, message.loaded / message.total) : null,
      });
      return;
    case "ready":
      setStatus(message.repo, { state: "ready" });
      return;
    case "load-error":
      setStatus(message.repo, { state: "error", message: message.message });
      return;
    case "result":
    case "error": {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.type === "result") request.resolve(message.text);
      else request.reject(new Error(message.message));
    }
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
    type: "module",
    name: "whisper",
  });
  worker.addEventListener("message", (event: MessageEvent<WhisperWorkerResponse>) =>
    handleMessage(event.data),
  );
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "The Whisper worker crashed.");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
    useWhisperStore.setState({ statusByRepo: {} });
  });
  return worker;
}

function send(request: WhisperWorkerRequest, transfer: Transferable[] = []) {
  getWorker().postMessage(request, transfer);
}

export function isVoiceDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** Starts downloading (or loading from cache) a model without transcribing. */
export function preloadWhisperModel(modelId: VoiceModelId) {
  const repo = WHISPER_MODELS[modelId].repo;
  const status = useWhisperStore.getState().statusByRepo[repo];
  if (status?.state === "ready" || status?.state === "downloading") return;
  setStatus(repo, { state: "downloading", progress: null });
  send({ type: "load", repo });
}

export function transcribeWithWhisper(
  audio: Float32Array,
  options: { readonly modelId: VoiceModelId; readonly language: string },
): Promise<string> {
  const model = WHISPER_MODELS[options.modelId];
  const status = useWhisperStore.getState().statusByRepo[model.repo];
  if (status?.state !== "ready") {
    setStatus(model.repo, { state: "downloading", progress: null });
  }
  const id = nextRequestId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send(
      {
        type: "transcribe",
        id,
        repo: model.repo,
        multilingual: model.multilingual,
        language: options.language,
        audio,
      },
      [audio.buffer],
    );
  });
}

async function openModelCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(TRANSFORMERS_CACHE_NAME);
  } catch {
    return null;
  }
}

function requestBelongsToRepo(request: Request, repo: string) {
  return request.url.includes(`/${repo}/`);
}

/** Models whose weights are already on this device. */
export async function listDownloadedWhisperModels(): Promise<ReadonlySet<VoiceModelId>> {
  const cache = await openModelCache();
  if (!cache) return new Set();
  const requests = await cache.keys();
  const downloaded = new Set<VoiceModelId>();
  for (const model of Object.values(WHISPER_MODELS)) {
    if (
      requests.some(
        (request) => requestBelongsToRepo(request, model.repo) && request.url.endsWith(".onnx"),
      )
    ) {
      downloaded.add(model.id);
    }
  }
  return downloaded;
}

/** Frees the disk space a model uses. It downloads again on next use. */
export async function deleteDownloadedWhisperModel(modelId: VoiceModelId): Promise<void> {
  const repo = WHISPER_MODELS[modelId].repo;
  const cache = await openModelCache();
  if (cache) {
    const requests = await cache.keys();
    await Promise.all(
      requests
        .filter((request) => requestBelongsToRepo(request, repo))
        .map((request) => cache.delete(request)),
    );
  }
  // The worker may still hold the model in memory; restart it so the next
  // use reloads from the network like a fresh install.
  if (useWhisperStore.getState().statusByRepo[repo] && pending.size === 0) {
    worker?.terminate();
    worker = null;
    useWhisperStore.setState({ statusByRepo: {} });
  }
}
