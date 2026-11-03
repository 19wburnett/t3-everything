import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import type { ToolActivityIcon } from "@t3tools/contracts";
import { collectToolFilePaths } from "@t3tools/shared/toolActivity";

import { COMPANY_DIR } from "../companyHub/companyHub.logic";

/** What a thread touched outside the code: the card shows these for cowork threads. */
export type WorkActivityKind = "email" | "social" | "browser" | "documents" | "apps";

export const WORK_ACTIVITY_KINDS: ReadonlyArray<{ kind: WorkActivityKind; title: string }> = [
  { kind: "email", title: "Email" },
  { kind: "social", title: "Social" },
  { kind: "browser", title: "Browser" },
  { kind: "documents", title: "Documents" },
  { kind: "apps", title: "Apps and connectors" },
];

export type WorkActivityTarget =
  | { readonly _tag: "url"; readonly url: string }
  | { readonly _tag: "file"; readonly path: string }
  | { readonly _tag: "draft"; readonly path: string }
  | { readonly _tag: "none" };

export interface WorkActivityItem {
  readonly key: string;
  readonly kind: WorkActivityKind;
  readonly label: string;
  readonly icon?: ToolActivityIcon;
  readonly target: WorkActivityTarget;
  /** Tool calls that touched it. */
  readonly count: number;
  /** Ordinal of the latest touch, newest first within a kind. */
  readonly lastOrdinal: number;
}

const EMAIL_SOURCE =
  /gmail|outlook|e-?mail|\bmail\b|resend|sendgrid|postmark|mailchimp|superhuman|fastmail|imap|smtp|instantly|lemlist|apollo/i;
const SOCIAL_SOURCE =
  /linkedin|twitter|\bx\b|facebook|instagram|threads|bluesky|reddit|tiktok|youtube|mastodon|buffer|hootsuite|typefully|discord|slack/i;
const DOCUMENT_SOURCE =
  /excel|\bword\b|powerpoint|google (docs|sheets|slides|drive)|\bdocs\b|\bsheets\b|\bslides\b|\bdrive\b|notion|numbers|pages|keynote|dropbox|\bbox\b|onedrive|sharepoint|airtable|canva|figma/i;
const DOCUMENT_FILE = /\.(docx?|xlsx?|xlsm|csv|tsv|pptx?|pdf|odt|ods|odp|rtf|pages|numbers|key)$/i;
const OUTBOX_DIR = `${COMPANY_DIR}/outbox/`;
const OUTBOX_DRAFT = new RegExp(`(?:^|/)(${OUTBOX_DIR}[^/]+\\.md)$`);
// Dev previews already show under Servers; only the outside web is cowork.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.+\.local|.+\.localhost)$/i;

function classifySource(name: string): WorkActivityKind {
  if (EMAIL_SOURCE.test(name)) return "email";
  if (SOCIAL_SOURCE.test(name)) return "social";
  if (DOCUMENT_SOURCE.test(name)) return "documents";
  return "apps";
}

function siteHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOST.test(host) ? null : host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function outboxRelativePath(path: string): string | null {
  return OUTBOX_DRAFT.exec(path.replaceAll("\\", "/"))?.[1] ?? null;
}

function itemPaths(item: ThreadStructureTurnItem): ReadonlyArray<string> {
  if (item.type === "file_change") return [item.fileName];
  if (item.type === "dynamic_tool") return collectToolFilePaths(item.input);
  return [];
}

export function deriveThreadWorkActivity(
  rows: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>,
): ReadonlyArray<WorkActivityItem> {
  const items = new Map<string, WorkActivityItem>();
  const touch = (next: Omit<WorkActivityItem, "count">) => {
    const previous = items.get(next.key);
    const icon = next.icon ?? previous?.icon;
    items.set(next.key, {
      ...next,
      ...(icon ? { icon } : {}),
      count: (previous?.count ?? 0) + 1,
      lastOrdinal: Math.max(previous?.lastOrdinal ?? 0, next.lastOrdinal),
    });
  };

  for (const { item } of rows) {
    const ordinal = item.ordinal;
    const { toolSource, toolIcon, toolSurface } = extractToolActivityPresentation(item);
    const pageUrl = toolIcon?._tag === "website" ? toolIcon.pageUrl : undefined;

    if (toolSurface === "browser" || toolSource?.kind === "browser") {
      const host = pageUrl ? siteHost(pageUrl) : null;
      if (pageUrl && host) {
        touch({
          key: `browser:${host}`,
          kind: "browser",
          label: host,
          ...(toolIcon ? { icon: toolIcon } : {}),
          target: { _tag: "url", url: pageUrl },
          lastOrdinal: ordinal,
        });
      }
    } else if (toolSource) {
      const icon = toolSource.icon ?? toolIcon;
      touch({
        key: `source:${toolSource.key}`,
        kind: classifySource(`${toolSource.name} ${toolSource.key}`),
        label: toolSource.name,
        ...(icon ? { icon } : {}),
        target: { _tag: "none" },
        lastOrdinal: ordinal,
      });
    }

    for (const path of itemPaths(item)) {
      const draft = outboxRelativePath(path);
      if (draft) {
        // The channel lives in the draft's frontmatter; the card resolves it from the outbox.
        touch({
          key: `draft:${draft}`,
          kind: "email",
          label: draft.slice(OUTBOX_DIR.length, -".md".length),
          target: { _tag: "draft", path: draft },
          lastOrdinal: ordinal,
        });
      } else if (DOCUMENT_FILE.test(path)) {
        touch({
          key: `file:${path}`,
          kind: "documents",
          label: path.split(/[\\/]/).pop() ?? path,
          target: { _tag: "file", path },
          lastOrdinal: ordinal,
        });
      }
    }
  }

  return [...items.values()].toSorted((a, b) => b.lastOrdinal - a.lastOrdinal);
}
