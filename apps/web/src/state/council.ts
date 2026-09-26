import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type CouncilProgress,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/** T3-Snow Council: the environment pushes the progress of every sitting council. */
export const councilEnvironment = {
  councils: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:council:councils",
    tag: WS_METHODS.subscribeCouncil,
  }),
  prepare: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:council:prepare",
    tag: WS_METHODS.councilPrepare,
  }),
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:council:start",
    tag: WS_METHODS.councilStart,
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:council:cancel",
    tag: WS_METHODS.councilCancel,
  }),
};

export function useCouncilSupported(environmentId: EnvironmentId | null): boolean {
  const serverConfigs = useServerConfigs();
  return (
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.council === true
  );
}

/** The council sitting in the thread, or null. */
export function useThreadCouncil(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): CouncilProgress | null {
  const supported = useCouncilSupported(environmentId);
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? councilEnvironment.councils({ environmentId, input: {} })
      : null,
  );
  const councils = query.data?.councils;
  return useMemo(
    () => councils?.find((entry) => entry.threadId === threadId) ?? null,
    [threadId, councils],
  );
}
