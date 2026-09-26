import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

/** T3-Snow: look inside, stop, and message a native subagent from the Agents panel. */
export const subagentControlEnvironment = {
  transcript: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:subagent:transcript",
    tag: WS_METHODS.subagentTranscript,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:subagent:stop",
    tag: WS_METHODS.subagentStop,
  }),
  message: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:subagent:message",
    tag: WS_METHODS.subagentMessage,
  }),
};

export function useSubagentControlSupported(environmentId: EnvironmentId | null): boolean {
  const serverConfigs = useServerConfigs();
  return (
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.subagentControl === true
  );
}
