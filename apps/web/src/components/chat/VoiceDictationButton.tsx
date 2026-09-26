import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

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
 * Whisper downloads or transcribes. While recording or transcribing, Enter
 * sends the message as soon as the transcript lands; Escape discards.
 */
export function VoiceDictationButton(props: {
  readonly phase: VoiceDictationPhase;
  readonly elapsedMs: number;
  readonly modelId: VoiceModelId;
  readonly shortcutLabel: string | null;
  readonly disabled?: boolean;
  /** Enter was pressed; the message goes out once the transcript lands. */
  readonly sendQueued: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onStopAndSend: () => void;
  readonly onCancel: () => void;
}) {
  const { phase, onCancel, onStopAndSend } = props;
  const model = WHISPER_MODELS[props.modelId];
  const status = useWhisperStore((state) => state.statusByRepo[model.repo]);

  // Claim Enter and Escape before the composer's own handlers see them: Enter
  // sends once the transcript lands, Escape discards the take.
  useEffect(() => {
    if (phase !== "recording" && phase !== "transcribing") return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        onStopAndSend();
        return;
      }
      if (event.key === "Escape" && phase === "recording") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, onStopAndSend, phase]);

  if (phase === "recording") {
    return (
      <div
        className="flex h-8 items-center gap-0.5 rounded-full border border-destructive/25 bg-destructive/8 ps-2.5 pe-0.5 text-destructive sm:h-7"
        role="group"
        aria-label="Recording voice"
      >
        <span className="me-1.5 size-2 rounded-full bg-destructive" aria-hidden />
        <span className="min-w-8 text-xs font-medium tabular-nums">
          {formatRecordingDuration(props.elapsedMs)}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-destructive"
                size="icon-xs"
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
            <span className="block text-muted-foreground">Enter to transcribe and send</span>
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-destructive"
                size="icon-xs"
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
          {downloading
            ? `Downloading Whisper${progress}`
            : props.sendQueued
              ? "Transcribing, then sending…"
              : "Transcribing…"}
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
            variant={phase === "starting" ? "ghost-destructive" : "ghost"}
            size="icon-sm"
            disabled={props.disabled || phase === "starting"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onStart}
            aria-label="Dictate with voice"
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
