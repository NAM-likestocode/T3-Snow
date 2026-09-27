import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

/** T3-Snow cloud dictation: the environment keeps the Deepgram key and calls Deepgram. */
export const voiceEnvironment = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:status",
    tag: WS_METHODS.voiceStatus,
  }),
  setDeepgramKey: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:set-deepgram-key",
    tag: WS_METHODS.voiceSetDeepgramKey,
  }),
  transcribe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:transcribe",
    tag: WS_METHODS.voiceTranscribe,
  }),
};

export function useCloudVoiceSupported(environmentId: EnvironmentId | null): boolean {
  const serverConfigs = useServerConfigs();
  return (
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.voiceTranscription === true
  );
}
