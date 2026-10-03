import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type DeferTrigger,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/**
 * T3-Snow deferred wake-ups: the environment pushes every armed trigger;
 * clients show the ones for the open thread and can cancel them.
 */
export const deferEnvironment = {
  triggers: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:defer:triggers",
    tag: WS_METHODS.subscribeDeferTriggers,
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:defer:cancel",
    tag: WS_METHODS.deferCancel,
  }),
};

const NO_TRIGGERS: ReadonlyArray<DeferTrigger> = [];

/** Armed wake-ups for one thread, soonest first. Empty on servers without defer. */
export function useThreadDeferTriggers(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<DeferTrigger> {
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.deferTriggers === true;
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? deferEnvironment.triggers({ environmentId, input: {} })
      : null,
  );
  const triggers = query.data?.triggers;
  return useMemo(
    () =>
      threadId === null || !triggers
        ? NO_TRIGGERS
        : triggers.filter((trigger) => trigger.threadId === threadId),
    [threadId, triggers],
  );
}
