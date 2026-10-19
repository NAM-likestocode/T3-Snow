import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { voiceEnvironment } from "~/state/voice";

import {
  blobToBase64,
  decodeRecordingForWhisper,
  describeMicrophoneError,
  isSilent,
  pickRecordingMimeType,
} from "./audio";
import { preloadWhisperModel, transcribeWithWhisper } from "./whisperEngine";

/** Longer recordings stop on their own so a forgotten mic never runs all day. */
export const VOICE_MAX_RECORDING_MS = 10 * 60_000;

export type VoiceDictationPhase = "idle" | "starting" | "recording" | "transcribing";

interface Recording {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly startedAt: number;
  discard: boolean;
}

function releaseStream(recording: Recording) {
  for (const track of recording.stream.getTracks()) track.stop();
}

export function useVoiceDictation(input: {
  /** The environment that transcribes when the Deepgram engine is chosen. */
  readonly environmentId: EnvironmentId | null;
  /** `send` is true when the user asked to send the message once transcribed. */
  readonly onTranscript: (text: string, options: { readonly send: boolean }) => void;
  readonly onError: (message: string) => void;
}) {
  const modelId = useClientSettings((settings) => settings.voiceModel);
  const language = useClientSettings((settings) => settings.voiceLanguage);
  const engine = useClientSettings((settings) => settings.voiceEngine);
  const transcribeInCloud = useAtomCommand(voiceEnvironment.transcribe, { reportFailure: false });
  const [phase, setPhaseState] = useState<VoiceDictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sendQueued, setSendQueued] = useState(false);
  const sendQueuedRef = useRef(false);
  const recordingRef = useRef<Recording | null>(null);
  // Mirrors `phase` synchronously so rapid toggles never start two recordings.
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  // False once the composer unmounts, so a late microphone grant is released at once.
  const mountedRef = useRef(true);
  const callbacksRef = useRef(input);
  const optionsRef = useRef({ modelId, language, engine, environmentId: input.environmentId });
  useEffect(() => {
    callbacksRef.current = input;
    optionsRef.current = { modelId, language, engine, environmentId: input.environmentId };
  });

  const setPhase = (next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const setSendAfterTranscript = (next: boolean) => {
    sendQueuedRef.current = next;
    setSendQueued(next);
  };

  // Resolves to the transcript, or to the message to show instead.
  const transcribe = async (
    blob: Blob,
  ): Promise<{ readonly text: string } | { readonly error: string }> => {
    const options = optionsRef.current;
    if (options.engine === "deepgram") {
      if (options.environmentId === null) {
        return { error: "Connect to an environment to use Deepgram." };
      }
      const result = await transcribeInCloud({
        environmentId: options.environmentId,
        input: {
          audioBase64: await blobToBase64(blob),
          mimeType: blob.type,
          language: options.language,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        return {
          error: error instanceof Error && error.message ? error.message : "Transcription failed.",
        };
      }
      const text = result.value.text?.trim();
      return text
        ? { text }
        : { error: result.value.message ?? "Didn't catch anything. Try speaking a little closer." };
    }
    const audio = await decodeRecordingForWhisper(blob);
    if (audio.length === 0 || isSilent(audio)) {
      return { error: "Didn't catch anything. Check your microphone and try again." };
    }
    const text = await transcribeWithWhisper(audio, options);
    return text ? { text } : { error: "Didn't catch anything. Try speaking a little closer." };
  };

  const finish = async (recording: Recording) => {
    releaseStream(recording);
    recordingRef.current = null;
    if (recording.discard || recording.chunks.length === 0) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    // try/catch rather than finally: the React Compiler cannot compile finally.
    let outcome: { readonly text: string } | { readonly error: string };
    try {
      outcome = await transcribe(new Blob(recording.chunks, { type: recording.recorder.mimeType }));
    } catch (error) {
      outcome = {
        error: error instanceof Error && error.message ? error.message : "Transcription failed.",
      };
    }
    if ("text" in outcome) {
      callbacksRef.current.onTranscript(outcome.text, { send: sendQueuedRef.current });
    } else {
      callbacksRef.current.onError(outcome.error);
    }
    setSendAfterTranscript(false);
    setPhase("idle");
  };

  const start = async () => {
    if (phaseRef.current !== "idle") return;
    setSendAfterTranscript(false);
    setPhase("starting");
    // Fetch or warm the model while the user talks, so the first dictation
    // does not wait for the whole download after they stop.
    if (optionsRef.current.engine === "local") preloadWhisperModel(optionsRef.current.modelId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setPhase("idle");
      callbacksRef.current.onError(describeMicrophoneError(error));
      return;
    }
    if (!mountedRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    let recording: Recording;
    try {
      const mimeType = pickRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recording = { stream, recorder, chunks: [], startedAt: Date.now(), discard: false };
      const current = recording;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) current.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => void finish(current));
      recorder.start();
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      setPhase("idle");
      callbacksRef.current.onError(
        error instanceof Error && error.message
          ? `Couldn't start recording: ${error.message}`
          : "Couldn't start recording.",
      );
      return;
    }
    recordingRef.current = recording;
    setElapsedMs(0);
    setPhase("recording");
  };

  const stop = () => {
    const recording = recordingRef.current;
    if (!recording || recording.recorder.state === "inactive") return;
    recording.recorder.stop();
  };

  /** Stops recording (if still running) and sends the message once transcribed. */
  const stopAndSend = () => {
    if (phaseRef.current !== "recording" && phaseRef.current !== "transcribing") return;
    setSendAfterTranscript(true);
    stop();
  };

  const cancel = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    setSendAfterTranscript(false);
    recording.discard = true;
    if (recording.recorder.state === "inactive") {
      releaseStream(recording);
      recordingRef.current = null;
      setPhase("idle");
    } else {
      recording.recorder.stop();
    }
  };

  const toggle = () => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") stop();
  };

  // Tick the visible timer and enforce the length cap only while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      const recording = recordingRef.current;
      if (!recording) return;
      const elapsed = Date.now() - recording.startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= VOICE_MAX_RECORDING_MS) stop();
    }, 250);
    return () => window.clearInterval(interval);
  }, [phase, stop]);

  // Never leave the microphone open after the composer unmounts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recording = recordingRef.current;
      if (!recording) return;
      recording.discard = true;
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      releaseStream(recording);
    };
  }, []);

  return { phase, elapsedMs, modelId, sendQueued, start, stop, stopAndSend, cancel, toggle };
}
