import { useNavigate } from "@tanstack/react-router";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type Seat = "optimist" | "skeptic" | "cfo" | "operator" | "chair";

const SEATS: ReadonlyArray<{ readonly id: Seat; readonly label: string }> = [
  { id: "optimist", label: "☀ Optimist" },
  { id: "skeptic", label: "☁ Skeptic" },
  { id: "cfo", label: "€ CFO" },
  { id: "operator", label: "⚙ Operator" },
  { id: "chair", label: "⚖ Chair" },
];

const ROUND_LABELS: Record<string, string> = {
  "1": "1 (opening only)",
  "2": "2 (opening + debate)",
  "3": "3 (two debate rounds)",
};

/** T3-Snow: Council defaults. A seat without its own model uses the thread's model. */
export function CouncilSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const council = settings.council;
  const defaults = DEFAULT_UNIFIED_SETTINGS.council;

  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const fallback = settings.helperModelSelection;

  const setSeat = (seat: Seat, selection: ModelSelection | null) =>
    updateSettings({ council: { models: { [seat]: selection } } });

  if (!hasServerTargets) return null;

  return (
    <SettingsSection id="council" title="Council">
      <SettingsRow
        serverScoped
        settingKeys={["council"]}
        {...searchableSetting("council-rounds")}
        description="Rounds when /council is sent without --rounds or --quick. Each round is four model runs, plus one for the chair."
        resetAction={
          council.rounds !== defaults.rounds ? (
            <SettingResetButton
              label="council rounds"
              onClick={() => updateSettings({ council: { rounds: defaults.rounds } })}
            />
          ) : null
        }
        control={
          <Select
            value={String(council.rounds)}
            onValueChange={(value) => updateSettings({ council: { rounds: Number(value) } })}
          >
            <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Council rounds">
              <SelectValue>{ROUND_LABELS[String(council.rounds)]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(ROUND_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["council"]}
        {...searchableSetting("council-web")}
        description="Let members search the web for facts that would change the verdict. Your idea text is sent to the search provider. --no-web turns it off for one council."
        control={
          <Switch
            checked={council.web}
            onCheckedChange={(checked) => updateSettings({ council: { web: Boolean(checked) } })}
            aria-label="Council web research"
          />
        }
      />
      {SEATS.map((seat) => {
        const selection = council.models[seat.id];
        const active = selection ?? fallback;
        return (
          <SettingsRow
            key={seat.id}
            serverScoped
            settingKeys={["council"]}
            {...(seat.id === "optimist" ? searchableSetting("council-models") : {})}
            title={seat.label}
            description={
              selection
                ? "Always sits on this model unless /council names one."
                : "Uses the thread's model. Turn on to pick one, e.g. to mix Claude and GPT."
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {selection ? (
                  <ProviderModelPicker
                    activeInstanceId={active.instanceId}
                    model={active.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={getCustomModelOptionsByInstance(
                      settings,
                      serverProviders,
                      active.instanceId,
                      active.model,
                    )}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={`${seat.label} model`}
                    getModelDisabledReason={disabledReason}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = disabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: "Council model not saved",
                          description: reason,
                        });
                        return;
                      }
                      setSeat(seat.id, createModelSelection(instanceId, model));
                    }}
                  />
                ) : null}
                <Switch
                  checked={selection !== null}
                  onCheckedChange={(checked) =>
                    setSeat(
                      seat.id,
                      checked
                        ? createModelSelection(
                            fallback.instanceId,
                            fallback.model,
                            fallback.options,
                          )
                        : null,
                    )
                  }
                  aria-label={`Pick a model for the ${seat.label}`}
                />
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
