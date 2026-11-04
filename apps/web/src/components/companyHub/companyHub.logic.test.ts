import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBrainImportPrompt,
  buildWorkTaskPrompt,
  COMPANY_BRAIN_TEMPLATES,
  groupThreadsByAgent,
  isStarterBrain,
  parseBrainSource,
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

describe("parseBrainSource", () => {
  it.each([
    [
      "acme/brain",
      { kind: "github", url: "https://github.com/acme/brain", repository: "acme/brain" },
    ],
    [
      "https://github.com/acme/brain.git",
      { kind: "github", url: "https://github.com/acme/brain", repository: "acme/brain" },
    ],
    [
      "github.com/acme/acme.github.io/tree/main/docs",
      {
        kind: "github",
        url: "https://github.com/acme/acme.github.io",
        repository: "acme/acme.github.io",
      },
    ],
    ["github.com/acme", { kind: "website", url: "https://github.com/acme" }],
    ["abcd1234.supabase.co", { kind: "supabase", url: "https://abcd1234.supabase.co/" }],
    [
      "https://supabase.com/dashboard/project/abcd1234",
      { kind: "supabase", url: "https://supabase.com/dashboard/project/abcd1234" },
    ],
    ["acme.com/about", { kind: "website", url: "https://acme.com/about" }],
  ])("reads %s", (input, expected) => {
    expect(parseBrainSource(input)).toEqual(expected);
  });

  it.each(["", "   ", "acme", "ftp://acme.com", "not a url"])("rejects %j", (input) => {
    expect(parseBrainSource(input)).toBeNull();
  });
});

describe("company brain import", () => {
  it("tells the agent how to read each kind of source and links it back", () => {
    const prompt = buildBrainImportPrompt(parseBrainSource("acme/brain")!);
    expect(prompt).toMatch(/^Our company brain lives in the GitHub repository/);
    expect(prompt).toContain('"## Source" section linking https://github.com/acme/brain');
    expect(buildBrainImportPrompt(parseBrainSource("abcd.supabase.co")!)).toContain(
      "change nothing in that project",
    );
  });

  it("treats only the untouched starter brain as replaceable", () => {
    const starter = COMPANY_BRAIN_TEMPLATES[0]!.contents;
    expect(isStarterBrain(`\n${starter}\n`)).toBe(true);
    expect(isStarterBrain(`${starter}\nWe sell boats.`)).toBe(false);
  });
});
