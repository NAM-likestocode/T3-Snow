import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveCouncilModel } from "./councilModels.ts";

function provider(instanceId: string, models: ReadonlyArray<[string, string]>) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: models.map(([slug, name]) => ({
      slug,
      name,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["low", "medium", "max"].map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
  } as unknown as ServerProvider;
}

const providers = [
  provider("claudeAgent", [
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
  ]),
  provider("codex", [["gpt-6-astra", "GPT-6 Astra"]]),
];
const defaultSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
};

describe("resolveCouncilModel", () => {
  it("uses the default model when no model is named", () => {
    expect(
      resolveCouncilModel({
        providers,
        defaultSelection,
        requested: undefined,
        effort: undefined,
        defaultName: "default",
      }),
    ).toEqual({ ok: true, selection: defaultSelection, label: "claude-opus-5-5:medium" });
  });

  it("matches loose names, preferring the configured model", () => {
    const resolve = (requested: string, effort?: string) =>
      resolveCouncilModel({
        providers,
        defaultSelection,
        requested,
        effort,
        defaultName: "default",
      });
    expect(resolve("opus")).toMatchObject({ label: "claude-opus-5-5:medium" });
    expect(resolve("Opus 4.8")).toMatchObject({ label: "claude-opus-4-8" });
    expect(resolve("codex/gpt-6-astra", "low")).toMatchObject({
      selection: { instanceId: "codex", model: "gpt-6-astra" },
      label: "gpt-6-astra:low",
    });
    expect(resolve("opus", "max")).toMatchObject({ label: "claude-opus-5-5:max" });
    expect(resolve("opus", "ultra")).toEqual({
      ok: false,
      error: 'effort "ultra" is not available for claude-opus-5-5 (choose low, medium, max)',
    });
  });
});
