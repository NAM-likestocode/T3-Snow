import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { formatRecordingDuration } from "~/voice/audio";
import type { VoiceDictationPhase } from "~/voice/useVoiceDictation";
import { WHISPER_MODELS } from "~/voice/whisperModels";
import { useWhisperStore } from "~/voice/whisperEngine";
import type { VoiceModelId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The composer's dictation control (T3-Snow). A mic while idle; a timer pill
 * with stop and cancel while recording; a quiet progress label while local
 * Whisper downloads or transcribes.
 */
export function VoiceDictationButton(props: {
  readonly phase: VoiceDictationPhase;
  readonly elapsedMs: number;
  readonly modelId: VoiceModelId;
  readonly shortcutLabel: string | null;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const { phase, onCancel } = props;
  const model = WHISPER_MODELS[props.modelId];
  const status = useWhisperStore((state) => state.statusByRepo[model.repo]);

  // Escape discards the take instead of reaching the composer's own handler.
  useEffect(() => {
    if (phase !== "recording") return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, phase]);

  if (phase === "recording") {
    return (
      <div
        className="flex h-8 items-center gap-0.5 rounded-full border border-destructive/25 bg-destructive/8 ps-2.5 pe-0.5 text-destructive sm:h-7"
        role="group"
        aria-label="Recording voice"
      >
        <span className="relative me-1.5 flex size-2">
          <span className="absolute inset-0 rounded-full bg-destructive/60 motion-safe:animate-ping" />
          <span className="relative size-2 rounded-full bg-destructive" />
        </span>
        <span className="min-w-8 text-xs font-medium tabular-nums">
          {formatRecordingDuration(props.elapsedMs)}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full text-destructive hover:bg-destructive/15 hover:text-destructive"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onStop}
                aria-label="Stop and transcribe"
              />
            }
          >
            <SquareIcon className="size-3 fill-current" />
          </TooltipTrigger>
          <TooltipPopup>
            Stop and transcribe
            {props.shortcutLabel ? <ShortcutHint label={props.shortcutLabel} /> : null}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full text-destructive/70 hover:bg-destructive/15 hover:text-destructive"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onCancel}
                aria-label="Discard recording"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>
            Discard
            <ShortcutHint label="Esc" />
          </TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  if (phase === "transcribing") {
    const downloading = status?.state === "downloading";
    const progress =
      downloading && status.progress !== null ? ` ${Math.round(status.progress * 100)}%` : "";
    return (
      <div
        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground sm:h-7"
        role="status"
        aria-live="polite"
      >
        <Spinner size="sm" />
        <span className="tabular-nums">
          {downloading ? `Downloading Whisper${progress}` : "Transcribing…"}
        </span>
      </div>
    );
  }

  const label =
    status?.state === "downloading"
      ? `Preparing ${model.label}${status.progress !== null ? ` · ${Math.round(status.progress * 100)}%` : "…"}`
      : "Dictate";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled || phase === "starting"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onStart}
            aria-label="Dictate with voice"
            className={cn(phase === "starting" && "text-destructive")}
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>
        {label}
        {props.shortcutLabel ? <ShortcutHint label={props.shortcutLabel} /> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function ShortcutHint({ label }: { label: string }) {
  return <span className="ms-2 text-muted-foreground">{label}</span>;
}
