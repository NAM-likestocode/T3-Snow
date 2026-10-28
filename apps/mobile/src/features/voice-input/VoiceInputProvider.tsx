import { useAtomValue } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { createServerVoiceTranscriber } from "../../native/serverVoiceTranscriber";
import { useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { type MobileVoiceEngine, resolveVoiceEngine } from "./voiceEngine";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
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

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
// T3-Snow: each recording is transcribed on the device or, with the Deepgram engine, on the
// starting composer's environment. Composers fill this in; the session reads it per recording.
type ServerTranscribe = (
  environmentId: EnvironmentId,
  input: Parameters<Parameters<typeof createServerVoiceTranscriber>[0]>[0],
) => ReturnType<Parameters<typeof createServerVoiceTranscriber>[0]>;
const voiceTranscriberSource: {
  environmentId: EnvironmentId | null;
  resolveEngineFor: (environmentId: EnvironmentId | null) => MobileVoiceEngine | null;
  transcribeOnServer: ServerTranscribe | null;
  permissionPromptOpen: boolean;
} = {
  environmentId: null,
  resolveEngineFor: () => (getLocalVoiceTranscriber() !== null ? "device" : null),
  transcribeOnServer: null,
  permissionPromptOpen: false,
};

const resolveVoiceTranscriber = () => {
  const source = voiceTranscriberSource;
  const engine = source.resolveEngineFor(source.environmentId);
  const transcribeOnServer = source.transcribeOnServer;
  if (engine === "deepgram" && source.environmentId !== null && transcribeOnServer !== null) {
    const environmentId = source.environmentId;
    return createServerVoiceTranscriber((request) => transcribeOnServer(environmentId, request));
  }
  return engine === "device" ? getLocalVoiceTranscriber() : null;
};

const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const recorder = createLazyVoiceRecorder({
    create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = microphoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: resolveVoiceTranscriber,
    requestPermission: async () => {
      // Android reports `background` while its microphone permission dialog is open.
      voiceTranscriberSource.permissionPromptOpen = true;
      try {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      } finally {
        voiceTranscriberSource.permissionPromptOpen = false;
      }
    },
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  // iOS reports `inactive` while its permission dialog is open. Only the real
  // background state cancels preparation; recorder status handles calls and
  // route interruptions during capture.
  const appStateSubscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "background" && !voiceTranscriberSource.permissionPromptOpen) {
      void session.controller.appMovedToBackground();
    }
  });
  get.addFinalizer(() => {
    appStateSubscription.remove();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const serverConfigs = useServerConfigs();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const voicePreference = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.voiceEngine
    : undefined;
  const transcribeOnServer = useAtomCommand(voiceEnvironment.transcribe, {
    reportFailure: false,
  });
  const deviceAvailable = getLocalVoiceTranscriber() !== null;
  const resolveEngineFor = (environmentId: EnvironmentId | null) =>
    resolveVoiceEngine({
      preference: voicePreference,
      deviceAvailable,
      deepgramAvailable:
        environmentId !== null &&
        serverConfigs.get(environmentId)?.environment.capabilities.voiceTranscription === true,
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the voice session lives outside React and reads the latest server transcriber from this module source
  useEffect(() => {
    voiceTranscriberSource.resolveEngineFor = resolveEngineFor;
    voiceTranscriberSource.transcribeOnServer = async (environmentId, input) => {
      const result = await transcribeOnServer({ environmentId, input });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw new Error(
          error instanceof Error && error.message ? error.message : "Transcription failed.",
        );
      }
      return result.value;
    };
  });
  return {
    ...snapshot,
    resolveEngineFor,
    setTranscriptionEnvironment: (environmentId: EnvironmentId | null) => {
      voiceTranscriberSource.environmentId = environmentId;
    },
    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
