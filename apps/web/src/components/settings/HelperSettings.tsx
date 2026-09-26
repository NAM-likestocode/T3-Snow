import { useNavigate } from "@tanstack/react-router";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
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
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** T3-Snow: the model helpers run on when an agent names none. */
export function HelperSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const mixed = useScopedSettingsMixed(["helperModelSelection"]);

  const selection = settings.helperModelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const isDirty = !Equal.equals(selection, DEFAULT_UNIFIED_SETTINGS.helperModelSelection);

  return (
    <SettingsSection id="helpers" title="Helpers">
      <SettingsRow
        serverScoped
        settingKeys={["helperModelSelection"]}
        {...searchableSetting("helper-model")}
        description="Agents can hand parts of a task to helpers that run in their own threads. Helpers use this model unless the agent picks another."
        resetAction={
          hasServerTargets && isDirty ? (
            <SettingResetButton
              label="helper model"
              onClick={() =>
                updateSettings({
                  helperModelSelection: DEFAULT_UNIFIED_SETTINGS.helperModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              Connect an environment to choose its helper model.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Helper model"
                {...(mixed ? { triggerLabel: "Mixed" } : {})}
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
                      title: "Helper model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({ helperModelSelection: createModelSelection(instanceId, model) });
                }}
              />
              {instanceEntry ? (
                <TraitsPicker
                  provider={instanceEntry.driverKind}
                  models={instanceEntry.models}
                  model={selection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={selection.options}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={settings.planModeEnabled}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(nextOptions) =>
                    updateSettings({
                      helperModelSelection: createModelSelection(
                        selection.instanceId,
                        selection.model,
                        nextOptions,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
          )
        }
      />
    </SettingsSection>
  );
}
