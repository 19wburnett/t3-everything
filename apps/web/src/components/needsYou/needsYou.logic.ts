import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";

type NeedsYouThread = Parameters<typeof resolveThreadStatusPill>[0]["thread"] & {
  readonly archivedAt: string | null;
  readonly updatedAt: string;
};

export type NeedsYouSectionKey = "decide" | "failed" | "finished";

export interface NeedsYouSection<T> {
  readonly key: NeedsYouSectionKey;
  readonly title: string;
  readonly items: ReadonlyArray<{ readonly thread: T; readonly status: ThreadStatusPill }>;
}

const SECTION_OF: Partial<Record<ThreadStatusPill["label"], NeedsYouSectionKey>> = {
  "Pending Approval": "decide",
  "Awaiting Input": "decide",
  "Guest Request": "decide",
  "Plan Ready": "decide",
  Failed: "failed",
  Completed: "finished",
};

const SECTION_TITLES: Record<NeedsYouSectionKey, string> = {
  decide: "Waiting on your decision",
  failed: "Failed",
  finished: "Finished since you looked",
};

/** Threads an agent handed back to the user, across every project: longest waits first, newest finishes first. */
export function groupNeedsYou<T extends NeedsYouThread>(
  threads: ReadonlyArray<T>,
  lastVisitedAtOf: (thread: T) => string | null | undefined,
): ReadonlyArray<NeedsYouSection<T>> {
  const sections = new Map<NeedsYouSectionKey, Array<{ thread: T; status: ThreadStatusPill }>>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const status = resolveThreadStatusPill({
      thread: { ...thread, lastVisitedAt: lastVisitedAtOf(thread) },
    });
    const key = status ? SECTION_OF[status.label] : undefined;
    if (!status || !key) continue;
    const items = sections.get(key) ?? [];
    items.push({ thread, status });
    sections.set(key, items);
  }
  return (["decide", "failed", "finished"] as const).flatMap((key) => {
    const items = sections.get(key);
    if (!items) return [];
    return [
      {
        key,
        title: SECTION_TITLES[key],
        items: items.toSorted((a, b) =>
          key === "finished"
            ? b.thread.updatedAt.localeCompare(a.thread.updatedAt)
            : a.thread.updatedAt.localeCompare(b.thread.updatedAt),
        ),
      },
    ];
  });
}
