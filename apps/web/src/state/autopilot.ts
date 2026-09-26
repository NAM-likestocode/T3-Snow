import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type AutopilotThreadState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/** T3-Snow Autopilot: the environment pushes each thread's Autopilot state. */
export const autopilotEnvironment = {
  threads: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:autopilot:threads",
    tag: WS_METHODS.subscribeAutopilot,
  }),
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:autopilot:start",
    tag: WS_METHODS.autopilotStart,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:autopilot:stop",
    tag: WS_METHODS.autopilotStop,
  }),
  resume: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:autopilot:resume",
    tag: WS_METHODS.autopilotResume,
  }),
};

export function useAutopilotSupported(environmentId: EnvironmentId | null): boolean {
  const serverConfigs = useServerConfigs();
  return (
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.autopilot === true
  );
}

/** The thread's Autopilot, or null when it is off. */
export function useThreadAutopilot(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): AutopilotThreadState | null {
  const supported = useAutopilotSupported(environmentId);
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? autopilotEnvironment.threads({ environmentId, input: {} })
      : null,
  );
  const threads = query.data?.threads;
  return useMemo(
    () => threads?.find((entry) => entry.threadId === threadId) ?? null,
    [threadId, threads],
  );
}
