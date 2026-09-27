import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS, VOICE_MODEL_IDS, type VoiceModelId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  deleteDownloadedWhisperModel,
  isVoiceDictationSupported,
  listDownloadedWhisperModels,
  preloadWhisperModel,
  useWhisperStore,
} from "../../voice/whisperEngine";
import { WHISPER_LANGUAGES, WHISPER_MODELS } from "../../voice/whisperModels";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { DeepgramKeyRow } from "./DeepgramKeyRow";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useCloudVoiceSupported } from "../../state/voice";

const ENGINE_LABELS = {
  local: "On this device (Whisper)",
  deepgram: "Deepgram (cloud)",
} as const;

const isVoiceModelId = (value: unknown): value is VoiceModelId =>
  typeof value === "string" && (VOICE_MODEL_IDS as ReadonlyArray<string>).includes(value);

/** Settings → Voice (T3-Snow). Everything here is device-local. */
export function VoiceSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const cloudSupported = useCloudVoiceSupported(primaryEnvironmentId);
  const engine = cloudSupported ? settings.voiceEngine : "local";
  const supported = isVoiceDictationSupported();
  const model = WHISPER_MODELS[settings.voiceModel];
  const status = useWhisperStore((state) => state.statusByRepo[model.repo]);
  const [downloaded, setDownloaded] = useState<ReadonlySet<VoiceModelId>>(new Set());
  const [removing, setRemoving] = useState(false);

  const refreshDownloaded = useCallback(() => {
    void listDownloadedWhisperModels().then(setDownloaded);
  }, []);
  // Re-read the cache whenever the selected model finishes loading.
  useEffect(refreshDownloaded, [refreshDownloaded, status?.state]);

  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.voice", {
    context: { terminalFocus: false, terminalOpen: false, modelPickerOpen: false },
  });
  const isDownloaded = downloaded.has(model.id) || status?.state === "ready";
  const isDownloading = status?.state === "downloading";

  const modelStatus = isDownloading
    ? `Downloading${status.progress !== null ? ` · ${Math.round(status.progress * 100)}%` : "…"}`
    : status?.state === "error"
      ? `Download failed: ${status.message}`
      : isDownloaded
        ? "Downloaded and ready to use offline."
        : `Downloads ${model.sizeLabel} the first time you dictate.`;

  const removeModel = async () => {
    setRemoving(true);
    try {
      await deleteDownloadedWhisperModel(model.id);
    } finally {
      setRemoving(false);
      refreshDownloaded();
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="voice" title="Voice">
        <SettingsUnavailableGroup
          message={
            supported
              ? undefined
              : "This browser can't record audio or run Whisper. Use the desktop app or a current Chromium browser."
          }
        >
          <SettingsRow
            {...searchableSetting("voice-dictation-enabled")}
            description="Speak into the composer. Whisper runs on this device for free and offline; Deepgram is faster and more accurate, using your own API key."
            resetAction={
              settings.voiceDictationEnabled !== DEFAULT_CLIENT_SETTINGS.voiceDictationEnabled ? (
                <SettingResetButton
                  label="voice dictation"
                  onClick={() =>
                    updateSettings({
                      voiceDictationEnabled: DEFAULT_CLIENT_SETTINGS.voiceDictationEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.voiceDictationEnabled}
                disabled={!supported}
                onCheckedChange={(checked) =>
                  updateSettings({ voiceDictationEnabled: Boolean(checked) })
                }
                aria-label="Voice dictation"
              />
            }
          />
          {settings.voiceDictationEnabled && cloudSupported ? (
            <SettingsRow
              {...searchableSetting("voice-engine")}
              description="Where your recording is turned into text. Deepgram sends the audio to Deepgram through the computer running T3 Code."
              control={
                <Select
                  value={engine}
                  onValueChange={(value) => {
                    if (value === "local" || value === "deepgram") {
                      updateSettings({ voiceEngine: value });
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Transcription">
                    <SelectValue>{ENGINE_LABELS[engine]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(["local", "deepgram"] as const).map((value) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {ENGINE_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          {settings.voiceDictationEnabled && engine === "deepgram" && primaryEnvironmentId ? (
            <DeepgramKeyRow environmentId={primaryEnvironmentId} />
          ) : null}
          {settings.voiceDictationEnabled ? (
            <>
              {engine === "local" ? (
                <SettingsRow
                  {...searchableSetting("voice-model")}
                  description={model.description}
                  status={
                    <span className="inline-flex items-center gap-1.5">
                      {isDownloading ? <Spinner size="xs" /> : null}
                      {modelStatus}
                    </span>
                  }
                  resetAction={
                    settings.voiceModel !== DEFAULT_CLIENT_SETTINGS.voiceModel ? (
                      <SettingResetButton
                        label="Whisper model"
                        onClick={() =>
                          updateSettings({ voiceModel: DEFAULT_CLIENT_SETTINGS.voiceModel })
                        }
                      />
                    ) : null
                  }
                  control={
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                      {isDownloaded ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={removing || isDownloading}
                          onClick={() => void removeModel()}
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={isDownloading}
                          onClick={() => preloadWhisperModel(model.id)}
                        >
                          Download
                        </Button>
                      )}
                      <Select
                        value={settings.voiceModel}
                        onValueChange={(value) => {
                          if (isVoiceModelId(value)) updateSettings({ voiceModel: value });
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full sm:w-52"
                          aria-label="Whisper model"
                        >
                          <SelectValue>{model.label}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          {VOICE_MODEL_IDS.map((id) => (
                            <SelectItem hideIndicator key={id} value={id}>
                              <span className="flex w-full items-center justify-between gap-3">
                                <span>{WHISPER_MODELS[id].label}</span>
                                <span className="text-muted-foreground text-xs tabular-nums">
                                  {downloaded.has(id) ? "Downloaded" : WHISPER_MODELS[id].sizeLabel}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  }
                />
              ) : null}
              {model.multilingual || engine === "deepgram" ? (
                <SettingsRow
                  {...searchableSetting("voice-language")}
                  description="Pin the spoken language for faster, more reliable results."
                  control={
                    <Select
                      value={settings.voiceLanguage}
                      onValueChange={(value) => {
                        if (typeof value === "string") updateSettings({ voiceLanguage: value });
                      }}
                    >
                      <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Language">
                        <SelectValue>
                          {WHISPER_LANGUAGES.find((entry) => entry.code === settings.voiceLanguage)
                            ?.label ?? settings.voiceLanguage}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        {WHISPER_LANGUAGES.map((entry) => (
                          <SelectItem hideIndicator key={entry.code} value={entry.code}>
                            {entry.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  }
                />
              ) : null}
              <SettingsRow
                {...searchableSetting("voice-shortcut")}
                description="Press once to start talking and again to transcribe. Esc discards the recording."
                control={
                  <div className="flex items-center gap-2">
                    {shortcutLabel ? <Kbd>{shortcutLabel}</Kbd> : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void navigate({ to: "/settings/keybindings" })}
                    >
                      Change
                    </Button>
                  </div>
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
