import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type HelperRun, type ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/**
 * T3-Snow helpers: the environment pushes running and recently finished
 * helpers; clients show the open thread's running ones and can stop them.
 */
export const helpersEnvironment = {
  runs: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:helpers:runs",
    tag: WS_METHODS.subscribeHelperRuns,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:helpers:stop",
    tag: WS_METHODS.helperStop,
  }),
};

const NO_RUNS: ReadonlyArray<HelperRun> = [];

/** Helpers the thread started that are still running, oldest first. Empty on servers without helpers. */
export function useThreadRunningHelpers(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<HelperRun> {
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.helperRuns === true;
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? helpersEnvironment.runs({ environmentId, input: {} })
      : null,
  );
  const runs = query.data?.runs;
  return useMemo(
    () =>
      threadId === null || !runs
        ? NO_RUNS
        : runs.filter((run) => run.parentThreadId === threadId && run.status === "running"),
    [threadId, runs],
  );
}
