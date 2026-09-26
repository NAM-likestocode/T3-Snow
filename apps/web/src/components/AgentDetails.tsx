/**
 * T3-Snow: the unfolded view of one native subagent in the Agents panel —
 * its conversation (when the provider keeps a readable transcript, i.e.
 * Claude) or its tool calls, plus Stop and a message box. Loaded only while
 * open, and refreshed when the agent reports new activity.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationThreadActivity,
  SubagentTranscriptEntry,
  ThreadId,
} from "@t3tools/contracts";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { subagentControlEnvironment } from "~/state/subagentControl";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { deriveAgentToolSteps } from "./AgentDetails.logic";

export interface AgentControlsScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/** Set by the Agents panel when the environment supports subagent controls. */
export const AgentControlsContext = createContext<AgentControlsScope | null>(null);

export function useAgentControls(): AgentControlsScope | null {
  return useContext(AgentControlsContext);
}

function isLive(agent: RuntimeSubagent): boolean {
  return agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
}

function TranscriptEntry({ entry }: { entry: SubagentTranscriptEntry }) {
  switch (entry.kind) {
    case "tool":
      return (
        <div className="flex min-w-0 gap-1.5 font-mono text-2xs">
          <span className="shrink-0 text-info-foreground">▸ {entry.toolName}</span>
          <span className="min-w-0 truncate text-muted-foreground">{entry.text}</span>
        </div>
      );
    case "tool-result":
      return (
        <div className="line-clamp-4 whitespace-pre-wrap border-l border-border/60 pl-2 font-mono text-2xs text-muted-foreground/80">
          {entry.text}
        </div>
      );
    case "thinking":
      return (
        <div className="line-clamp-6 whitespace-pre-wrap text-xs italic text-muted-foreground">
          {entry.text}
        </div>
      );
    case "prompt":
      return (
        <div className="line-clamp-6 whitespace-pre-wrap rounded-sm bg-muted/40 px-2 py-1 text-xs">
          {entry.text}
        </div>
      );
    case "text":
      return <div className="whitespace-pre-wrap text-xs text-foreground/90">{entry.text}</div>;
  }
}

export function AgentDetails({ agent }: { agent: RuntimeSubagent }) {
  const scope = useAgentControls();
  const loadTranscript = useAtomCommand(subagentControlEnvironment.transcript, {
    reportFailure: false,
  });
  const stop = useAtomCommand(subagentControlEnvironment.stop, { reportFailure: false });
  const sendMessage = useAtomCommand(subagentControlEnvironment.message, { reportFailure: false });
  const [transcript, setTranscript] = useState<{
    readonly entries: ReadonlyArray<SubagentTranscriptEntry> | null;
    readonly omitted: number;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const environmentId = scope?.environmentId ?? null;
  const threadId = scope?.threadId ?? null;
  // Reload when the agent reports something new; nothing polls.
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    let cancelled = false;
    void loadTranscript({ environmentId, input: { threadId, taskId: agent.id } }).then((result) => {
      if (!cancelled && result._tag === "Success") setTranscript(result.value);
    });
    return () => {
      cancelled = true;
    };
    // agent.updatedAt is the refresh signal: a new activity means a new step to show.
  }, [environmentId, threadId, agent.id, agent.updatedAt, loadTranscript]);

  const toolSteps = useMemo(
    () => (scope ? deriveAgentToolSteps(scope.activities, agent.id) : []),
    [scope, agent.id],
  );

  if (!scope) return null;
  const target = {
    environmentId: scope.environmentId,
    input: { threadId: scope.threadId, taskId: agent.id },
  };

  const report = (title: string, result: Awaited<ReturnType<typeof stop>>) => {
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Try again.",
      });
      return false;
    }
    if (!result.value.ok) {
      toastManager.add({ type: "warning", title, description: result.value.message });
      return false;
    }
    return true;
  };

  const onStop = async () => {
    setBusy(true);
    report("Couldn't stop the agent", await stop(target));
    setBusy(false);
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    const sent = report(
      "Couldn't send the message",
      await sendMessage({
        environmentId: scope.environmentId,
        input: { threadId: scope.threadId, taskId: agent.id, title: agent.title, text },
      }),
    );
    setBusy(false);
    if (sent) {
      setDraft("");
      toastManager.add({
        type: "info",
        title: "Sent to the main agent",
        description: "It passes your message on to this agent.",
      });
    }
  };

  const entries = transcript?.entries ?? null;
  return (
    <div className="mb-1 ml-3.5 flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-2">
      <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
        {entries && entries.length > 0 ? (
          <>
            {transcript && transcript.omitted > 0 ? (
              <div className="text-2xs text-muted-foreground">
                {transcript.omitted} earlier steps not shown
              </div>
            ) : null}
            {entries.map((entry, index) => (
              <TranscriptEntry key={index} entry={entry} />
            ))}
          </>
        ) : toolSteps.length > 0 || agent.recentActivity.length > 0 ? (
          <>
            {toolSteps.map((step) => (
              <div key={step.id} className="flex min-w-0 gap-1.5 font-mono text-2xs">
                <span className="shrink-0 text-info-foreground">▸ {step.title}</span>
                <span className="min-w-0 truncate text-muted-foreground">{step.detail}</span>
              </div>
            ))}
            {toolSteps.length === 0
              ? agent.recentActivity.map((entry, index) => (
                  <div key={index} className="truncate text-xs text-muted-foreground">
                    {entry.summary}
                  </div>
                ))
              : null}
          </>
        ) : (
          <div className="text-xs text-muted-foreground">
            {transcript === null ? "Loading…" : "Nothing to show yet."}
          </div>
        )}
        {agent.result || agent.error ? (
          <div
            className={cn(
              "whitespace-pre-wrap border-t border-border/60 pt-1.5 text-xs",
              agent.error ? "text-destructive-foreground" : "text-foreground/90",
            )}
          >
            {agent.error ?? agent.result}
          </div>
        ) : null}
      </div>
      <div className="flex items-end gap-1.5">
        <Textarea
          size="sm"
          rows={1}
          value={draft}
          placeholder="Message this agent…"
          aria-label={`Message ${agent.title}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSend();
            }
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !draft.trim()}
          onClick={() => void onSend()}
        >
          Send
        </Button>
        {isLive(agent) ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void onStop()}>
            Stop
          </Button>
        ) : null}
      </div>
    </div>
  );
}
