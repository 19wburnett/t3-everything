import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupNeedsYou } from "./needsYou.logic";

const run = (status: "completed" | "failed", completedAt: string) => ({
  runId: RunId.make(`run:${completedAt}`),
  status,
  requestedAt: null,
  startedAt: null,
  completedAt,
  assistantMessageId: MessageId.make("message:reply"),
});

const thread = (
  id: string,
  updatedAt: string,
  overrides: Partial<Parameters<typeof groupNeedsYou>[0][number]> = {},
) => ({
  id,
  updatedAt,
  archivedAt: null,
  lastVisitedAt: "2026-11-01T10:00:00Z",
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestRun: null,
  runtime: null,
  ...overrides,
});

describe("groupNeedsYou", () => {
  it("sorts handed-back threads into decisions, failures, and unseen finishes", () => {
    const threads = [
      thread("approval-new", "2026-11-01T12:00:00Z", { hasPendingApprovals: true }),
      thread("input-old", "2026-11-01T09:00:00Z", { hasPendingUserInput: true }),
      thread("failed", "2026-11-01T11:00:00Z", {
        latestRun: run("failed", "2026-11-01T11:00:00Z"),
      }),
      thread("finished-early", "2026-11-01T10:30:00Z", {
        latestRun: run("completed", "2026-11-01T10:30:00Z"),
      }),
      thread("finished-late", "2026-11-01T11:30:00Z", {
        latestRun: run("completed", "2026-11-01T11:30:00Z"),
      }),
      thread("seen", "2026-11-01T09:30:00Z", {
        latestRun: run("completed", "2026-11-01T09:30:00Z"),
      }),
      thread("archived", "2026-11-01T12:00:00Z", {
        hasPendingApprovals: true,
        archivedAt: "2026-11-01T12:30:00Z",
      }),
    ];
    expect(
      groupNeedsYou(threads, (entry) => entry.lastVisitedAt).map((section) => [
        section.key,
        section.items.map((item) => item.thread.id),
      ]),
    ).toEqual([
      ["decide", ["input-old", "approval-new"]],
      ["failed", ["failed"]],
      ["finished", ["finished-late", "finished-early"]],
    ]);
  });
});
