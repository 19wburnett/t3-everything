import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CompanyDraft,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ToolActivityIcon,
} from "@t3tools/contracts";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";
import { AsyncResult } from "effect/reactivity";
import {
  AppWindowIcon,
  FileTextIcon,
  GlobeIcon,
  MailIcon,
  MessageSquareIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useQuietThreadVisibleTurnItems } from "~/state/entities";
import { CompanyChannelIcon } from "../companyHub/CompanyChannelIcon";
import { CHANNEL_NAMES, firstLine } from "../companyHub/companyChannels.logic";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";
import {
  deriveThreadWorkActivity,
  WORK_ACTIVITY_KINDS,
  type WorkActivityItem,
  type WorkActivityKind,
} from "./threadWorkActivity";

const MAX_ROWS_PER_KIND = 5;

const KIND_ICONS: Record<WorkActivityKind, LucideIcon> = {
  email: MailIcon,
  social: MessageSquareIcon,
  browser: GlobeIcon,
  documents: FileTextIcon,
  apps: AppWindowIcon,
};

const DRAFT_STATUS = { draft: "Draft", sent: "Sent", failed: "Failed to send" } as const;

interface ThreadWorkPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/** The email, social, browser, document and app work this thread did. Hidden while there is none. */
export function ThreadWorkPanel(props: ThreadWorkPanelProps) {
  const rows = useQuietThreadVisibleTurnItems(scopeThreadRef(props.environmentId, props.threadId));
  const items = deriveThreadWorkActivity(rows);
  if (items.length === 0) return null;
  return items.some((item) => item.target._tag === "draft") ? (
    <ThreadWorkWithDrafts {...props} items={items} />
  ) : (
    <ThreadWorkSection {...props} items={items} drafts={null} />
  );
}

function ThreadWorkWithDrafts(
  props: ThreadWorkPanelProps & { readonly items: ReadonlyArray<WorkActivityItem> },
) {
  const outbox = AsyncResult.getOrElse(
    useAtomValue(
      companyChannelEnvironment.outbox({
        environmentId: props.environmentId,
        input: { projectId: props.projectId },
      }),
    ),
    () => null,
  );
  const drafts = new Map(outbox?.drafts.map((draft) => [draft.path, draft]));
  return <ThreadWorkSection {...props} drafts={drafts} />;
}

function ThreadWorkSection(
  props: ThreadWorkPanelProps & {
    readonly items: ReadonlyArray<WorkActivityItem>;
    readonly drafts: ReadonlyMap<string, CompanyDraft> | null;
  },
) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const openLink = useOpenLink(threadRef);
  const { resolvedTheme } = useTheme();
  const draftOf = (item: WorkActivityItem) =>
    item.target._tag === "draft" ? props.drafts?.get(item.target.path) : undefined;
  // Drafts read their channel from the outbox; posts belong under Social.
  const kindOf = (item: WorkActivityItem): WorkActivityKind => {
    const channel = draftOf(item)?.channel;
    return channel && channel !== "email" ? "social" : item.kind;
  };

  const open = (item: WorkActivityItem, event: MouseEvent) => {
    const { target } = item;
    if (target._tag === "url") {
      openLink(target.url, { event }).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Unable to open link",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (target._tag === "file" || target._tag === "draft") {
      useRightPanelStore.getState().openFile(threadRef, target.path);
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-work-heading" title="Work">
      <div className="flex flex-col gap-1">
        {WORK_ACTIVITY_KINDS.map(({ kind, title }) => {
          const group = props.items.filter((item) => kindOf(item) === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} role="group" aria-label={title}>
              <div className="px-2.5 pt-1 pb-0.5 text-2xs font-medium text-muted-foreground/80 select-none">
                {title}
              </div>
              <ul className="m-0 list-none p-0">
                {group.slice(0, MAX_ROWS_PER_KIND).map((item) => {
                  const draft = draftOf(item);
                  const detail = draft
                    ? [CHANNEL_NAMES[draft.channel], DRAFT_STATUS[draft.status]].join(" · ")
                    : item.target._tag === "draft"
                      ? "Outbox draft"
                      : item.count > 1
                        ? `${item.count} actions`
                        : null;
                  const label = draft
                    ? draft.subject || firstLine(draft.body) || item.label
                    : item.label;
                  const content: ReactNode = (
                    <>
                      {draft ? (
                        <CompanyChannelIcon
                          kind={draft.channel}
                          className={THREAD_DETAILS_PANEL_ICON_CLASS}
                        />
                      ) : (
                        <WorkActivityIcon
                          icon={item.icon}
                          fallback={KIND_ICONS[kind]}
                          theme={resolvedTheme}
                        />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                          {label}
                        </span>
                        {detail ? (
                          <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                            {detail}
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                  return (
                    <li key={item.key}>
                      {item.target._tag === "none" ? (
                        // Connectors have nothing to open; they read as plain rows.
                        <div
                          className={cn(
                            THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
                            "flex h-auto min-h-8 items-center py-0.75",
                          )}
                        >
                          {content}
                        </div>
                      ) : (
                        <ThreadDetailsControl
                          size="sm"
                          variant="ghost"
                          part="row"
                          multiline
                          title={item.target._tag === "url" ? item.target.url : undefined}
                          onClick={(event) => open(item, event)}
                        >
                          {content}
                        </ThreadDetailsControl>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </ThreadDetailsSection>
  );
}

function WorkActivityIcon(props: {
  readonly icon: ToolActivityIcon | undefined;
  readonly fallback: LucideIcon;
  readonly theme: "light" | "dark";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const icon = props.icon;
  const src =
    icon?._tag === "website"
      ? toolActivityFaviconUrl(icon, props.theme, 32)
      : icon?._tag === "themed-logo"
        ? props.theme === "dark"
          ? (icon.logoUrlDark ?? icon.logoUrl)
          : icon.logoUrl
        : null;
  if (!src || src === failedSrc) {
    const Fallback = props.fallback;
    return <Fallback aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      className="size-4 shrink-0 rounded-sm"
      onError={() => setFailedSrc(src)}
    />
  );
}
