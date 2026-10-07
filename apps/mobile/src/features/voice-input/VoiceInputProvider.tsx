import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { createServerVoiceTranscriber } from "../../native/serverVoiceTranscriber";
import { useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { resolveVoiceEngine } from "./voiceEngine";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);
  // Android reports `background` while its microphone permission dialog is open.
  const permissionPromptOpenRef = useRef(false);

  // T3-Snow: dictation can also transcribe on the starting composer's server with its Deepgram key.
  const serverConfigs = useServerConfigs();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const voicePreference = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.voiceEngine
    : undefined;
  const transcribeOnServer = useAtomCommand(voiceEnvironment.transcribe, {
    reportFailure: false,
  });
  const deviceTranscriberAvailable = getLocalVoiceTranscriber() !== null;
  const resolveEngineFor = useCallback(
    (environmentId: EnvironmentId | null) =>
      resolveVoiceEngine({
        preference: voicePreference,
        deviceAvailable: deviceTranscriberAvailable,
        deepgramAvailable:
          environmentId !== null &&
          serverConfigs.get(environmentId)?.environment.capabilities.voiceTranscription === true,
      }),
    [deviceTranscriberAvailable, serverConfigs, voicePreference],
  );
  const transcriberSourceRef = useRef({
    environmentId: null as EnvironmentId | null,
    resolveEngineFor,
    transcribeOnServer,
  });
  transcriberSourceRef.current.resolveEngineFor = resolveEngineFor;
  transcriberSourceRef.current.transcribeOnServer = transcribeOnServer;
  const setTranscriptionEnvironment = useCallback((environmentId: EnvironmentId | null) => {
    transcriberSourceRef.current.environmentId = environmentId;
  }, []);

  if (!sessionRef.current || !recorderRef.current) {
    // The native recorder is created when dictation starts, not on app launch.
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        sessionRef.current?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
        });
      },
    });
    recorderRef.current = recorder;
    sessionRef.current = new VoiceInputSession({
      recorder,
      getTranscriber: () => {
        const source = transcriberSourceRef.current;
        const engine = source.resolveEngineFor(source.environmentId);
        if (engine === "deepgram" && source.environmentId !== null) {
          const environmentId = source.environmentId;
          return createServerVoiceTranscriber(async (request) => {
            const result = await source.transcribeOnServer({ environmentId, input: request });
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              throw new Error(
                error instanceof Error && error.message ? error.message : "Transcription failed.",
              );
            }
            return result.value;
          });
        }
        return engine === "device" ? getLocalVoiceTranscriber() : null;
      },
      requestPermission: async () => {
        permissionPromptOpenRef.current = true;
        try {
          const permission = await requestRecordingPermissionsAsync();
          return { granted: permission.granted, canAskAgain: permission.canAskAgain };
        } finally {
          permissionPromptOpenRef.current = false;
        }
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        }),
    });
  }

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` and Android `background` while the permission
      // dialog is open. Only a real background state cancels preparation;
      // recorder status handles calls and route interruptions during capture.
      if (nextState === "background" && !permissionPromptOpenRef.current) {
        controller.appMovedToBackground();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      // Dispose first so an active recording is stopped before the recorder is released.
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable: deviceTranscriberAvailable || getNativeShowcaseScene() !== null,
    resolveEngineFor,
    setTranscriptionEnvironment,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
  };
}
