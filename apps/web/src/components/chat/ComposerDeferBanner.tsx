import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AlarmClockIcon, CircleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { deferEnvironment, useThreadDeferTriggers } from "~/state/defer";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { deferTriggerState, describeDeferStatus } from "./ComposerDeferBanner.logic";

const STATE_ICONS = {
  time: AlarmClockIcon,
  pending: CircleIcon,
  checking: RefreshCwIcon,
  broken: TriangleAlertIcon,
} as const;

/**
 * T3-Snow: the thread's armed wake-ups above the composer, soonest first,
 * with a live countdown and a cancel button for each. Hidden when none.
 */
export const ComposerDeferBanner = memo(function ComposerDeferBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const triggers = useThreadDeferTriggers(environmentId, threadId);
  const cancel = useAtomCommand(deferEnvironment.cancel, { reportFailure: false });
  const [now, setNow] = useState(() => Date.now());
  const hasTriggers = triggers.length > 0;

  // A once-a-second text update, only while something is armed.
  useEffect(() => {
    if (!hasTriggers) return;
    const tick = () => setNow(Date.now());
    // Catch up right away when wake-ups appear after a quiet stretch.
    queueMicrotask(tick);
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [hasTriggers]);

  if (!hasTriggers || environmentId === null) return null;

  const cancelTrigger = async (triggerId: string) => {
    const result = await cancel({ environmentId, input: { triggerId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't cancel the wake-up",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-composer-defer-banner="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <AlarmClockIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="text-muted-foreground">Wake-ups</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{triggers.length} armed</ComposerBanner.Count>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {triggers.map((trigger) => {
          const state = deferTriggerState(trigger);
          const StateIcon = STATE_ICONS[state];
          return (
            <ComposerBanner.Row key={trigger.id} data-defer-trigger-state={state}>
              <ComposerBanner.Icon
                className={cn(
                  state === "pending" && "text-muted-foreground/50",
                  state === "broken" && "text-warning",
                )}
              >
                <StateIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content
                title={trigger.check ? `when \`${trigger.check}\`` : undefined}
              >
                <span className="shrink-0 font-mono text-muted-foreground">{trigger.id}</span>
                <span className="min-w-0 flex-1 truncate text-foreground/80">{trigger.note}</span>
                {trigger.run ? (
                  <span className="shrink-0 text-muted-foreground/60">→run</span>
                ) : null}
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <span
                  className={cn(
                    "text-muted-foreground tabular-nums",
                    state === "broken" && "text-warning",
                  )}
                >
                  {describeDeferStatus(trigger, now)}
                </span>
                <ComposerBanner.Dismiss
                  aria-label={`Cancel wake-up ${trigger.id}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void cancelTrigger(trigger.id)}
                />
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          );
        })}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
