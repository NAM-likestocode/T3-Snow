import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * T3-Snow: the Deepgram API key, stored in the environment's secret store.
 * The key is write-only from here: the page only learns whether one is set.
 */
export function DeepgramKeyRow({ environmentId }: { environmentId: EnvironmentId }) {
  const loadStatus = useAtomCommand(voiceEnvironment.status, { reportFailure: false });
  const setKey = useAtomCommand(voiceEnvironment.setDeepgramKey, { reportFailure: false });
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStatus({ environmentId, input: {} }).then((result) => {
      if (!cancelled && result._tag === "Success") setKeySet(result.value.deepgramKeySet);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, loadStatus]);

  const save = async (apiKey: string | null) => {
    setSaving(true);
    const result = await setKey({ environmentId, input: { apiKey } });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Deepgram key not saved",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return;
    }
    setKeySet(result.value.deepgramKeySet);
    if (result.value.message) {
      toastManager.add({
        type: "error",
        title: "Deepgram key not saved",
        description: result.value.message,
      });
      return;
    }
    setDraft("");
  };

  return (
    <SettingsRow
      {...searchableSetting("voice-deepgram-key")}
      description="Your key from console.deepgram.com. It's kept in this environment's secret store and never shown again; other devices connected to it use the same key."
      status={keySet === null ? "Checking…" : keySet ? "Key saved." : "No key saved yet."}
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            type="password"
            autoComplete="off"
            className="sm:w-56"
            placeholder={keySet ? "Replace key" : "Paste API key"}
            aria-label="Deepgram API key"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim()) void save(draft.trim());
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={saving || !draft.trim()}
            onClick={() => void save(draft.trim())}
          >
            Save
          </Button>
          {keySet ? (
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => void save(null)}>
              Remove
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
