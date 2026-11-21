import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { BotIcon } from "lucide-react";
import { memo } from "react";

import { autopilotEnvironment, useThreadAutopilot } from "~/state/autopilot";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";

/**
 * T3-Snow: shows the thread's Autopilot goal while it is on, with Stop, and
 * Resume when a restart or its turn/time budget paused it.
 */
export const ComposerAutopilotBanner = memo(function ComposerAutopilotBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const gt = useGT();
  const autopilot = useThreadAutopilot(environmentId, threadId);
  const stop = useAtomCommand(autopilotEnvironment.stop, { reportFailure: false });
  const resume = useAtomCommand(autopilotEnvironment.resume, { reportFailure: false });
  if (!autopilot || environmentId === null || threadId === null) return null;
  const paused = autopilot.status === "paused";

  const run = async (command: typeof stop, failureTitle: string) => {
    const result = await command({ environmentId, input: { threadId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : gt("Try again."),
      });
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-composer-autopilot-banner="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <BotIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium">
              {paused ? gt("Autopilot paused") : gt("Autopilot")}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{autopilot.goal}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {paused ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void run(resume, gt("Couldn't resume Autopilot"))}
              >
                <T>Resume</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void run(stop, gt("Couldn't stop Autopilot"))}
            >
              <T>Stop</T>
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
