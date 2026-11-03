import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadWorkActivity } from "./threadWorkActivity";

let ordinal = 0;
const row = (item: Record<string, unknown>) => ({
  item: { status: "completed", ordinal: ++ordinal, ...item } as unknown as ThreadStructureTurnItem,
});
const mcp = (key: string, name: string) =>
  row({
    type: "dynamic_tool",
    toolName: `mcp__${key}__do`,
    input: {},
    toolSource: { key: `mcp:${key}`, name, kind: "integration" },
  });
const browse = (pageUrl: string) =>
  row({
    type: "dynamic_tool",
    toolName: "t3-code.preview_navigate",
    input: {},
    toolSurface: "browser",
    toolIcon: { _tag: "website", pageUrl },
  });

describe("deriveThreadWorkActivity", () => {
  it("sorts connectors into email, social, documents and apps, counting repeat calls", () => {
    const items = deriveThreadWorkActivity([
      mcp("gmail", "Gmail"),
      mcp("linkedin", "LinkedIn"),
      mcp("google_sheets", "Google Sheets"),
      mcp("linear", "Linear"),
      mcp("gmail", "Gmail"),
    ]);
    expect(items.map((item) => [item.label, item.kind, item.count])).toEqual([
      ["Gmail", "email", 2],
      ["Linear", "apps", 1],
      ["Google Sheets", "documents", 1],
      ["LinkedIn", "social", 1],
    ]);
  });

  it("lists outside sites by host and leaves dev previews to Servers", () => {
    const items = deriveThreadWorkActivity([
      browse("https://www.linkedin.com/feed/"),
      browse("http://localhost:5173/"),
      browse("https://www.linkedin.com/in/someone"),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "browser",
        label: "linkedin.com",
        count: 2,
        target: { _tag: "url", url: "https://www.linkedin.com/in/someone" },
      }),
    ]);
  });

  it("picks out office documents and outbox drafts from changed files", () => {
    const items = deriveThreadWorkActivity([
      row({ type: "file_change", fileName: "src/index.ts" }),
      row({ type: "file_change", fileName: "reports/q3.xlsx" }),
      row({ type: "file_change", fileName: "/home/me/acme/company/outbox/follow-up-acme.md" }),
      row({ type: "file_change", fileName: "company/outbox/archive/old.md" }),
    ]);
    expect(items.map((item) => [item.kind, item.label, item.target])).toEqual([
      ["email", "follow-up-acme", { _tag: "draft", path: "company/outbox/follow-up-acme.md" }],
      ["documents", "q3.xlsx", { _tag: "file", path: "reports/q3.xlsx" }],
    ]);
  });
});
