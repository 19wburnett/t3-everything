import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { useProviderEntryByEnvironmentAndInstanceId } from "~/hooks/useProviderEntryByEnvironmentAndInstanceId";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { useUiStateStore } from "../../uiStateStore";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { groupNeedsYou } from "./needsYou.logic";

export function NeedsYouPage() {
  const threads = useThreadShells();
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById);
  const sections = groupNeedsYou(threads, (thread) =>
    resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localLastVisitedAt[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    ),
  );
  const companyByProject = new Map(
    useSettingsProjectGroups().flatMap((group) =>
      group.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}:${ref.projectId}`, group.displayName] as const,
      ),
    ),
  );
  const providerEntries = useProviderEntryByEnvironmentAndInstanceId();
  const navigate = useNavigate();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <WorkspaceBreadcrumb ariaLabel="Needs you" className="overflow-hidden">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Needs you</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing needs you</EmptyTitle>
              <EmptyDescription>
                Approvals, questions, failures, and finished work from every agent show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <WorkspacePageContainer width="expanded">
            {sections.map((section) => (
              <section
                key={section.key}
                aria-labelledby={`needs-you-${section.key}`}
                className="flex flex-col gap-2"
              >
                <h2
                  id={`needs-you-${section.key}`}
                  className="text-sm font-medium text-muted-foreground"
                >
                  {section.title} · {section.items.length}
                </h2>
                <ul className="flex flex-col rounded-xl border border-border/60 bg-card p-1.5">
                  {section.items.map(({ thread, status }) => {
                    const entry = providerEntries.get(
                      `${thread.environmentId}:${thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId}`,
                    );
                    return (
                      <li key={`${thread.environmentId}:${thread.id}`}>
                        <button
                          type="button"
                          onClick={() =>
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(thread.environmentId, thread.id),
                              ),
                            })
                          }
                          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          {entry ? (
                            <ProviderInstanceIcon
                              driverKind={entry.driverKind as ProviderDriverKind}
                              displayName={entry.displayName}
                              accentColor={entry.accentColor}
                              className="size-4 shrink-0"
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                            {companyByProject.get(`${thread.environmentId}:${thread.projectId}`)}
                          </span>
                          <span className={`shrink-0 text-xs ${status.colorClass}`}>
                            {status.label}
                          </span>
                          <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {formatRelativeTimeLabel(thread.updatedAt)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </WorkspacePageContainer>
        )}
      </div>
    </SidebarInset>
  );
}
