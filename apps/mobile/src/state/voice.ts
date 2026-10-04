import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** T3-Snow: transcription on the environment with its Deepgram key. */
export const voiceEnvironment = {
  transcribe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:transcribe",
    tag: WS_METHODS.voiceTranscribe,
  }),
};
