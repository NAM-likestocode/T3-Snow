/**
 * Picks the provider instance, model, and effort a council seat runs on (T3-Snow).
 *
 * With no model named, a seat uses its default (a Council setting or the
 * thread's model). A named model
 * may be any model of a usable provider (enabled, installed, available, and
 * not signed out), matched loosely: `opus`, `claude-opus-5-5`, `Opus 5.5`,
 * or `claudeAgent/claude-opus-5-5`. Nothing falls back silently: an unusable
 * choice is refused with the names that would work.
 *
 * @module council/councilModels
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

const EFFORT_OPTION_IDS = ["effort", "reasoningEffort"] as const;

export interface ResolvedCouncilModel {
  readonly selection: ModelSelection;
  /** Short name for messages, e.g. `claude-opus-5-5:medium`. */
  readonly label: string;
}

export type CouncilModelResolution =
  | ({ readonly ok: true } & ResolvedCouncilModel)
  | { readonly ok: false; readonly error: string };

export function isCouncilProviderUsable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.auth.status !== "unauthenticated"
  );
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function modelNames(model: ServerProviderModel): ReadonlyArray<string> {
  return [model.slug, model.name, model.shortName, ...(model.aliases ?? [])]
    .filter((name): name is string => Boolean(name))
    .map(squash);
}

function effortDescriptorId(model: ServerProviderModel): string | undefined {
  return model.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      (EFFORT_OPTION_IDS as ReadonlyArray<string>).includes(descriptor.id),
  )?.id;
}

function effortChoices(model: ServerProviderModel): ReadonlyArray<string> {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === effortDescriptorId(model),
  );
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
}

function currentEffort(selection: ModelSelection): string | undefined {
  const option = selection.options?.find((entry) =>
    (EFFORT_OPTION_IDS as ReadonlyArray<string>).includes(entry.id),
  );
  return typeof option?.value === "string" ? option.value : undefined;
}

function withEffort(
  selection: ModelSelection,
  model: ServerProviderModel | undefined,
  effort: string | undefined,
): ModelSelection | string {
  if (!effort) return selection;
  const id = model ? effortDescriptorId(model) : undefined;
  if (!model || !id) return `${selection.model} has no effort setting`;
  const wanted = effort.trim().toLowerCase();
  const choice = effortChoices(model).find((entry) => entry.toLowerCase() === wanted);
  if (!choice) {
    return `effort "${effort}" is not available for ${selection.model} (choose ${effortChoices(model).join(", ")})`;
  }
  const others: ProviderOptionSelection[] = (selection.options ?? []).filter(
    (entry) => !(EFFORT_OPTION_IDS as ReadonlyArray<string>).includes(entry.id),
  );
  return { ...selection, options: [...others, { id, value: choice }] };
}

function labelFor(selection: ModelSelection): string {
  const effort = currentEffort(selection);
  return effort ? `${selection.model}:${effort}` : selection.model;
}

/** Names an agent can pass as `model`, for error messages and the profile list. */
export function listCouncilModelNames(providers: ReadonlyArray<ServerProvider>): string {
  const names = providers
    .filter(isCouncilProviderUsable)
    .flatMap((provider) =>
      provider.models.filter((model) => !model.isLegacy).map((model) => model.slug),
    );
  return names.length > 0 ? names.join(", ") : "none (no provider is ready)";
}

export function resolveCouncilModel(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly defaultSelection: ModelSelection;
  readonly requested: string | undefined;
  readonly effort: string | undefined;
  /** How errors name the default, e.g. "thread's model". */
  readonly defaultName: string;
}): CouncilModelResolution {
  const usable = input.providers.filter(isCouncilProviderUsable);
  const requested = input.requested?.trim();

  const finish = (
    selection: ModelSelection,
    model: ServerProviderModel | undefined,
  ): CouncilModelResolution => {
    const withChosenEffort = withEffort(selection, model, input.effort);
    if (typeof withChosenEffort === "string") return { ok: false, error: withChosenEffort };
    return { ok: true, selection: withChosenEffort, label: labelFor(withChosenEffort) };
  };

  if (!requested || squash(requested) === "default") {
    const provider = input.providers.find(
      (entry) => entry.instanceId === input.defaultSelection.instanceId,
    );
    if (!provider || !isCouncilProviderUsable(provider)) {
      return {
        ok: false,
        error: `The ${input.defaultName} ${input.defaultSelection.model} is not usable because its provider (${input.defaultSelection.instanceId}) is not enabled, installed, and signed in. Name another model; usable: ${listCouncilModelNames(input.providers)}.`,
      };
    }
    const model = provider.models.find((entry) => entry.slug === input.defaultSelection.model);
    return finish(input.defaultSelection, model);
  }

  // `instance/model` names the provider instance explicitly.
  const slash = requested.indexOf("/");
  const scoped = slash > 0 ? usable.filter((p) => p.instanceId === requested.slice(0, slash)) : [];
  const query = squash(slash > 0 && scoped.length > 0 ? requested.slice(slash + 1) : requested);
  const pool = scoped.length > 0 ? scoped : usable;
  // The default's provider wins ties, so `opus` means the configured Opus.
  const ordered = [
    ...pool.filter((p) => p.instanceId === input.defaultSelection.instanceId),
    ...pool.filter((p) => p.instanceId !== input.defaultSelection.instanceId),
  ];
  const candidates = ordered.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const exact = candidates.find(({ model }) => modelNames(model).includes(query));
  const isDefaultModel = (model: ServerProviderModel) =>
    model.slug === input.defaultSelection.model;
  const partial =
    candidates.find(
      ({ model }) =>
        isDefaultModel(model) && modelNames(model).some((name) => name.includes(query)),
    ) ??
    candidates.find(
      ({ model }) => !model.isLegacy && modelNames(model).some((name) => name.includes(query)),
    );
  const found = query ? (exact ?? partial) : undefined;
  if (!found) {
    return {
      ok: false,
      error: `No usable model matches "${requested}". Usable: ${listCouncilModelNames(input.providers)}.`,
    };
  }
  const base: ModelSelection =
    found.provider.instanceId === input.defaultSelection.instanceId && isDefaultModel(found.model)
      ? input.defaultSelection
      : { instanceId: found.provider.instanceId, model: found.model.slug };
  return finish(base, found.model);
}
