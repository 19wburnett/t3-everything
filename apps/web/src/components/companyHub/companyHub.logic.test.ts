import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkTaskPrompt,
  groupThreadsByAgent,
  resolveHandOff,
  resolveWorkTaskModelSelection,
  WORK_TASK_PRESETS,
} from "./companyHub.logic";

const presetById = (id: string) => WORK_TASK_PRESETS.find((preset) => preset.id === id)!;

describe("groupThreadsByAgent", () => {
  it("puts bridge agents first, one lane per instance, then busier code lanes, newest first", () => {
    const threads = [
      { id: "c1", driver: "claudeAgent", instance: "claude", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "x1", driver: "codex", instance: "codex", updatedAt: "2026-10-02T00:00:00Z" },
      { id: "c2", driver: "claudeAgent", instance: "work", updatedAt: "2026-10-03T00:00:00Z" },
      { id: "g1", driver: "agentBridge", instance: "grokBot", updatedAt: "2026-10-04T00:00:00Z" },
      { id: "m1", driver: "agentBridge", instance: "museBot", updatedAt: "2026-10-05T00:00:00Z" },
      { id: "m2", driver: "agentBridge", instance: "museBot", updatedAt: "2026-10-06T00:00:00Z" },
      { id: "mc", driver: "muse", instance: "muse", updatedAt: "2026-10-07T00:00:00Z" },
    ];
    const lanes = groupThreadsByAgent(threads, (thread) => ({
      driverKind: thread.driver,
      instanceId: thread.instance,
    }));
    expect(
      lanes.map((lane) => [lane.key, lane.kind, lane.threads.map((thread) => thread.id)]),
    ).toEqual([
      ["museBot", "work", ["m2", "m1"]],
      ["grokBot", "work", ["g1"]],
      ["claudeAgent", "code", ["c2", "c1"]],
      ["codex", "code", ["x1"]],
      ["muse", "code", ["mc"]],
    ]);
  });
});

describe("buildWorkTaskPrompt", () => {
  it("points only coding agents at the company brain, and leaves coding blank", () => {
    const outbound = presetById("outbound");
    expect(buildWorkTaskPrompt(outbound, false)).toBe(outbound.prompt);
    expect(buildWorkTaskPrompt(outbound, true)).toBe(outbound.prompt);
    expect(
      buildWorkTaskPrompt({ ...outbound, target: { kind: "coding", provider: "codex" } }, true),
    ).toMatch(/^Read the files in company\/ first/);
    expect(buildWorkTaskPrompt(presetById("code"), true)).toBe("");
  });
});

describe("resolveWorkTaskModelSelection", () => {
  it("selects an enabled bridge instance and warns when it is missing or disabled", () => {
    const bridge = (instanceId: string, enabled: boolean) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("agentBridge"),
      enabled,
      status: "ready" as const,
      models: [],
    });
    const muse = presetById("outbound").target;
    const providers = [bridge("museBot", true), bridge("grokBot", false)];
    expect(resolveWorkTaskModelSelection(providers, muse)).toEqual({
      selection: { instanceId: "museBot", model: "default" },
    });
    expect(resolveWorkTaskModelSelection(providers, presetById("social").target)).toEqual({
      warning: "Grok Bot isn't connected on this machine.",
    });
    expect(resolveWorkTaskModelSelection([], muse)).toEqual({
      warning: "Muse isn't connected on this machine.",
    });
  });
});

describe("resolveHandOff", () => {
  it("offers only set-up coding agents, and only for a hosted agent's thread", () => {
    const provider = (instanceId: string, driver: string, enabled = true) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(driver),
      displayName: instanceId === "museBot" ? "Muse" : undefined,
      enabled,
      status: "ready" as const,
      models: [{ slug: "default", name: "Default", isDefault: true }],
    });
    const providers = [
      provider("museBot", "agentBridge"),
      provider("claudeAgent", "claudeAgent"),
      provider("codex", "codex", false),
    ];
    expect(resolveHandOff(providers, "museBot")).toEqual({
      agentName: "Muse",
      targets: [{ provider: "claude", label: "Claude" }],
    });
    expect(resolveHandOff(providers, "claudeAgent")).toBeNull();
    expect(resolveHandOff([provider("museBot", "agentBridge")], "museBot")).toBeNull();
  });
});
