import type { CouncilSeatProgress, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ScaleIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { councilEnvironment, useThreadCouncil } from "~/state/council";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { formatDeferDuration } from "./ComposerDeferBanner.logic";

function describeSeat(seat: CouncilSeatProgress): string {
  switch (seat.status) {
    case "waiting":
      return "waiting";
    case "thinking":
      return "thinking…";
    case "searching":
      return `🔎 ${seat.detail ?? "searching…"}`;
    case "done":
      return `done · ${seat.detail ?? ""}`;
    case "failed":
      return `failed · ${seat.detail ?? "unknown error"}`;
  }
}

/** T3-Snow: live progress of the council sitting in this thread, with Cancel. */
export const ComposerCouncilBanner = memo(function ComposerCouncilBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const council = useThreadCouncil(environmentId, threadId);
  const cancel = useAtomCommand(councilEnvironment.cancel, { reportFailure: false });
  const [now, setNow] = useState(() => Date.now());
  const sitting = council !== null;

  // A once-a-second elapsed time, only while a council sits.
  useEffect(() => {
    if (!sitting) return;
    const tick = () => setNow(Date.now());
    queueMicrotask(tick);
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [sitting]);

  if (!council || environmentId === null || threadId === null) return null;

  const cancelCouncil = async () => {
    const result = await cancel({ environmentId, input: { threadId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't cancel the council",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-composer-council-banner="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <ScaleIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium">Council</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {council.phase} · {formatDeferDuration(now - Date.parse(council.startedAt))} ·{" "}
              {council.model}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button size="xs" variant="ghost" onClick={() => void cancelCouncil()}>
              Cancel
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {council.seats.map((seat) => (
          <ComposerBanner.Row key={seat.id}>
            <ComposerBanner.Icon className="text-muted-foreground">
              <span aria-hidden>{seat.icon}</span>
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="w-20 shrink-0 text-foreground/80">{seat.name}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-muted-foreground",
                  seat.status === "failed" && "text-warning",
                )}
              >
                {describeSeat(seat)}
              </span>
            </ComposerBanner.Content>
          </ComposerBanner.Row>
        ))}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
