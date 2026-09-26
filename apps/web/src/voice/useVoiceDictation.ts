import { useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";

import {
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
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const modelId = useClientSettings((settings) => settings.voiceModel);
  const language = useClientSettings((settings) => settings.voiceLanguage);
  const [phase, setPhaseState] = useState<VoiceDictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  // Mirrors `phase` synchronously so rapid toggles never start two recordings.
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const callbacksRef = useRef(input);
  const optionsRef = useRef({ modelId, language });
  useEffect(() => {
    callbacksRef.current = input;
    optionsRef.current = { modelId, language };
  });

  const setPhase = useCallback((next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const finish = useCallback(
    async (recording: Recording) => {
      releaseStream(recording);
      recordingRef.current = null;
      if (recording.discard || recording.chunks.length === 0) {
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      try {
        const audio = await decodeRecordingForWhisper(
          new Blob(recording.chunks, { type: recording.recorder.mimeType }),
        );
        if (audio.length === 0 || isSilent(audio)) {
          callbacksRef.current.onError(
            "Didn't catch anything. Check your microphone and try again.",
          );
          return;
        }
        const text = await transcribeWithWhisper(audio, optionsRef.current);
        if (text) callbacksRef.current.onTranscript(text);
        else callbacksRef.current.onError("Didn't catch anything. Try speaking a little closer.");
      } catch (error) {
        callbacksRef.current.onError(
          error instanceof Error && error.message ? error.message : "Transcription failed.",
        );
      } finally {
        setPhase("idle");
      }
    },
    [setPhase],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setPhase("starting");
    // Fetch or warm the model while the user talks, so the first dictation
    // does not wait for the whole download after they stop.
    preloadWhisperModel(optionsRef.current.modelId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      setPhase("idle");
      callbacksRef.current.onError(describeMicrophoneError(error));
      return;
    }
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const recording: Recording = {
      stream,
      recorder,
      chunks: [],
      startedAt: Date.now(),
      discard: false,
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => void finish(recording));
    recordingRef.current = recording;
    recorder.start();
    setElapsedMs(0);
    setPhase("recording");
  }, [finish, setPhase]);

  const stop = useCallback(() => {
    const recording = recordingRef.current;
    if (!recording || recording.recorder.state === "inactive") return;
    recording.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const recording = recordingRef.current;
    if (!recording) return;
    recording.discard = true;
    if (recording.recorder.state === "inactive") {
      releaseStream(recording);
      recordingRef.current = null;
      setPhase("idle");
    } else {
      recording.recorder.stop();
    }
  }, [setPhase]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") stop();
  }, [start, stop]);

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
  useEffect(
    () => () => {
      const recording = recordingRef.current;
      if (!recording) return;
      recording.discard = true;
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      releaseStream(recording);
    },
    [],
  );

  return { phase, elapsedMs, modelId, start, stop, cancel, toggle };
}
