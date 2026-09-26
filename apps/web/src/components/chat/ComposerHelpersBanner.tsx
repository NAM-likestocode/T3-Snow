import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { helpersEnvironment, useThreadRunningHelpers } from "~/state/helpers";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { formatDeferDuration } from "./ComposerDeferBanner.logic";

/**
 * T3-Snow: helpers this thread started that are still running, with their
 * model and elapsed time. Clicking one opens its thread; × stops it.
 */
export const ComposerHelpersBanner = memo(function ComposerHelpersBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const runs = useThreadRunningHelpers(environmentId, threadId);
  const stop = useAtomCommand(helpersEnvironment.stop, { reportFailure: false });
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const hasRuns = runs.length > 0;

  // A once-a-second text update, only while something runs.
  useEffect(() => {
    if (!hasRuns) return;
    const tick = () => setNow(Date.now());
    queueMicrotask(tick);
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [hasRuns]);

  if (!hasRuns || environmentId === null) return null;

  const stopRun = async (runId: string) => {
    const result = await stop({ environmentId, input: { runId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't stop the helper",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-composer-helpers-banner="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <UsersIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="text-muted-foreground">Helpers</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{runs.length} running</ComposerBanner.Count>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {runs.map((run) => (
          <ComposerBanner.Row key={run.id}>
            <ComposerBanner.Icon className="text-muted-foreground/50">
              <UsersIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-foreground/80 hover:underline"
                aria-label={`Open helper ${run.name}`}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: run.threadId },
                  })
                }
              >
                {run.name}
              </button>
              <span className="shrink-0 text-muted-foreground/60">{run.model}</span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <span className="text-muted-foreground tabular-nums">
                {formatDeferDuration(now - Date.parse(run.startedAt))}
              </span>
              <ComposerBanner.Dismiss
                aria-label={`Stop helper ${run.name}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void stopRun(run.id)}
              />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ))}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
