import { describe, expect, it } from "vite-plus/test";

import { buildWorkTaskPrompt, groupThreadsByAgent, WORK_TASK_PRESETS } from "./companyHub.logic";

describe("groupThreadsByAgent", () => {
  it("puts work agents first, then busier lanes, with threads newest first", () => {
    const threads = [
      { id: "c1", driver: "claudeAgent", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "x1", driver: "codex", updatedAt: "2026-10-02T00:00:00Z" },
      { id: "c2", driver: "claudeAgent", updatedAt: "2026-10-03T00:00:00Z" },
      { id: "g1", driver: "grok", updatedAt: "2026-10-04T00:00:00Z" },
      { id: "m1", driver: "muse", updatedAt: "2026-10-05T00:00:00Z" },
      { id: "m2", driver: "muse", updatedAt: "2026-10-06T00:00:00Z" },
    ];
    const lanes = groupThreadsByAgent(threads, (thread) => thread.driver);
    expect(
      lanes.map((lane) => [lane.driverKind, lane.kind, lane.threads.map((thread) => thread.id)]),
    ).toEqual([
      ["muse", "work", ["m2", "m1"]],
      ["grok", "work", ["g1"]],
      ["claudeAgent", "code", ["c2", "c1"]],
      ["codex", "code", ["x1"]],
    ]);
  });
});

describe("buildWorkTaskPrompt", () => {
  it("points work tasks at the company brain only when it exists, and leaves coding blank", () => {
    const outbound = WORK_TASK_PRESETS.find((preset) => preset.id === "outbound")!;
    const code = WORK_TASK_PRESETS.find((preset) => preset.id === "code")!;
    expect(buildWorkTaskPrompt(outbound, false)).toBe(outbound.prompt);
    expect(buildWorkTaskPrompt(outbound, true)).toMatch(/^Read the files in company\/ first/);
    expect(buildWorkTaskPrompt(code, true)).toBe("");
  });
});
