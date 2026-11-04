import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type CompanyDraft,
  type ProjectId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { BookOpenIcon, DownloadIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useId, useState } from "react";

import { isElectron } from "~/env";
import { useProviderEntryByEnvironmentAndInstanceId } from "~/hooks/useProviderEntryByEnvironmentAndInstanceId";
import { cn } from "~/lib/utils";
import { isProviderInstancePickerReady } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useThreadShells } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getProjectFileQueryAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { channelFailure } from "./companyChannels.logic";
import { CompanyChannelsSection } from "./CompanyChannelsSection";
import {
  AGENT_BRIDGE_DRIVER,
  type BrainSource,
  brainSourceLabel,
  type BridgeAgent,
  buildBrainImportPrompt,
  buildWorkTaskPrompt,
  COMPANY_BRAIN_TEMPLATES,
  COMPANY_DIR,
  connectedBridgeAgents,
  groupThreadsByAgent,
  isStarterBrain,
  parseBrainSource,
  type WorkTaskTarget,
  WORK_TASK_PRESETS,
} from "./companyHub.logic";
import { CompanyInboxSection } from "./CompanyInboxSection";
import { CompanyOutboxSection } from "./CompanyOutboxSection";
import { useStartWorkThread } from "./useStartWorkThread";
import { useWriteCompanyBrain } from "./useWriteCompanyBrain";

const LANE_THREAD_LIMIT = 8;

export function CompanyHubPage({ projectKey }: { projectKey: string }) {
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === projectKey);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <WorkspaceBreadcrumb ariaLabel="Company hub" className="overflow-hidden">
          <WorkspaceBreadcrumbItem>Company hub</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{group?.displayName ?? "Unknown project"}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link to="/settings/projects" search={{ project: projectKey, machine: undefined }} />
            }
          >
            <Settings2Icon aria-hidden />
            Project settings
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        {group ? (
          <CompanyHubBody group={group} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Project not found</EmptyTitle>
              <EmptyDescription>
                It may have been removed, or its machine is not connected.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </SidebarInset>
  );
}

function CompanyHubBody({ group }: { group: SidebarProjectSnapshot }) {
  // New threads and the company brain use the group's first member, like the sidebar's new-thread button.
  const primary = group.memberProjects[0] ?? group;
  const brainAtom = getProjectFileQueryAtom(
    primary.environmentId,
    primary.workspaceRoot,
    COMPANY_BRAIN_TEMPLATES[0]!.relativePath,
  );
  const brainResult = useAtomValue(brainAtom);
  const brain = AsyncResult.getOrElse(brainResult, () => null);
  const hasCompanyBrain = brain !== null && brain.exists !== false;

  const canReadChannels = useEnvironmentScope(primary.environmentId, AuthFilesystemReadScope);
  const startWorkThread = useStartWorkThread();
  const startThread = (prompt: string, target: WorkTaskTarget) =>
    startWorkThread(primary, prompt, target);

  return (
    <WorkspacePageContainer width="expanded">
      <section aria-labelledby="company-hub-start" className="flex flex-col gap-3">
        <h2 id="company-hub-start" className="text-sm font-medium text-muted-foreground">
          Start work
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {WORK_TASK_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                void startThread(buildWorkTaskPrompt(preset, hasCompanyBrain), preset.target)
              }
              className="flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="text-sm font-medium">{preset.label}</span>
              <span className="text-xs text-muted-foreground">{preset.description}</span>
            </button>
          ))}
        </div>
      </section>
      <AgentLanes
        group={group}
        environmentId={primary.environmentId}
        onNewBridgeThread={(agent) => void startThread("", { kind: "bridge", agent })}
      />
      {canReadChannels ? (
        <CompanyChannelSections
          environmentId={primary.environmentId}
          projectId={primary.id}
          onAskAgent={(agent, prompt) => void startThread(prompt, { kind: "bridge", agent })}
        />
      ) : null}
      <CompanyBrain
        environmentId={primary.environmentId}
        workspaceRoot={primary.workspaceRoot}
        brainLoading={brainResult._tag === "Initial"}
        brainContents={hasCompanyBrain ? brain.contents : null}
        onCreated={() => appAtomRegistry.refresh(brainAtom)}
        onImport={(prompt) => void startThread(prompt, { kind: "coding", provider: "claude" })}
      />
    </WorkspacePageContainer>
  );
}

function CompanyChannelSections(props: {
  readonly environmentId: SidebarProjectSnapshot["environmentId"];
  readonly projectId: ProjectId;
  readonly onAskAgent: (agent: BridgeAgent, prompt: string) => void;
}) {
  const target = { environmentId: props.environmentId, input: { projectId: props.projectId } };
  const accountsResult = useAtomValue(companyChannelEnvironment.accounts(target));
  const outboxResult = useAtomValue(companyChannelEnvironment.outbox(target));
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    props.environmentId,
  );
  const [editingDraft, setEditingDraft] = useState<CompanyDraft | null>(null);
  const accounts = AsyncResult.getOrElse(accountsResult, () => null)?.accounts ?? [];
  const failureOf = (result: typeof accountsResult | typeof outboxResult) =>
    result._tag === "Failure" ? channelFailure(result.cause).message : null;

  return (
    <>
      <CompanyInboxSection
        environmentId={props.environmentId}
        projectId={props.projectId}
        accounts={accounts}
        agents={connectedBridgeAgents(providers ?? [])}
        onAskAgent={props.onAskAgent}
        onDraftCreated={setEditingDraft}
      />
      <CompanyOutboxSection
        environmentId={props.environmentId}
        projectId={props.projectId}
        accounts={accounts}
        outbox={AsyncResult.getOrElse(outboxResult, () => null)}
        error={failureOf(outboxResult)}
        editing={editingDraft}
        onEdit={setEditingDraft}
      />
      <CompanyChannelsSection
        environmentId={props.environmentId}
        projectId={props.projectId}
        accounts={accounts}
        loading={accountsResult._tag === "Initial"}
        error={failureOf(accountsResult)}
      />
    </>
  );
}

function AgentLanes({
  group,
  environmentId,
  onNewBridgeThread,
}: {
  group: SidebarProjectSnapshot;
  environmentId: SidebarProjectSnapshot["environmentId"];
  onNewBridgeThread: (agent: BridgeAgent) => void;
}) {
  const memberKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const threads = useThreadShells().filter(
    (thread) =>
      thread.archivedAt === null && memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  const providerEntries = useProviderEntryByEnvironmentAndInstanceId();
  const instanceIdOf = (thread: (typeof threads)[number]) =>
    thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entryOf = (thread: (typeof threads)[number]) =>
    providerEntries.get(`${thread.environmentId}:${instanceIdOf(thread)}`);
  const lanes = groupThreadsByAgent(threads, (thread) => ({
    driverKind: entryOf(thread)?.driverKind ?? "unknown",
    instanceId: instanceIdOf(thread),
  }));
  const bridgeEntries = [...providerEntries].flatMap(([key, entry]) =>
    key.startsWith(`${environmentId}:`) && entry.driverKind === AGENT_BRIDGE_DRIVER ? [entry] : [],
  );
  const bridgeReady = bridgeEntries.some(isProviderInstancePickerReady);
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    environmentId,
  );
  const bridgeDocsUrl = bridgeEntries.find((entry) => entry.snapshot.setup?.documentationUrl)
    ?.snapshot.setup?.documentationUrl;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const navigate = useNavigate();

  return (
    <section aria-labelledby="company-hub-agents" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-agents" className="text-sm font-medium text-muted-foreground">
          Agents
        </h2>
        <div className="ml-auto flex flex-wrap gap-1">
          {connectedBridgeAgents(providers ?? []).map((agent) => (
            <Button
              key={agent.instanceId}
              size="sm"
              variant="outline"
              onClick={() => onNewBridgeThread(agent)}
            >
              <PlusIcon aria-hidden />
              New {agent.displayName} thread
            </Button>
          ))}
        </div>
      </div>
      {bridgeReady ? null : (
        <p className="text-sm text-muted-foreground">
          Connect Muse or Grok Bot in{" "}
          <Link
            to="/settings/providers"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings &gt; Providers
          </Link>{" "}
          to run outbound, email, social, and support work.
          {bridgeDocsUrl ? (
            <>
              {" "}
              <a
                href={bridgeDocsUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Setup guide
              </a>
            </>
          ) : null}
        </p>
      )}
      {lanes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No threads yet. Start work above, or start a thread from the sidebar.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lanes.map((lane) => {
            const entry = lane.threads[0] ? entryOf(lane.threads[0]) : undefined;
            const showAll = expanded.has(lane.key);
            const shown = showAll ? lane.threads : lane.threads.slice(0, LANE_THREAD_LIMIT);
            return (
              <div
                key={lane.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  {entry ? (
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind as ProviderDriverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      className="size-4"
                    />
                  ) : null}
                  <span className="text-sm font-medium">{entry?.displayName ?? lane.key}</span>
                  <span className="text-xs text-muted-foreground">
                    {lane.kind === "work" ? "Work" : "Code"} · {lane.threads.length}
                  </span>
                </div>
                <ul className="flex flex-col">
                  {shown.map((thread) => (
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
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ThreadRowLeadingStatus thread={thread} />
                        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatRelativeTimeLabel(thread.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {lane.threads.length > LANE_THREAD_LIMIT ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (showAll) next.delete(lane.key);
                        else next.add(lane.key);
                        return next;
                      })
                    }
                  >
                    {showAll ? "Show fewer" : `Show all ${lane.threads.length}`}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CompanyBrain(props: {
  environmentId: SidebarProjectSnapshot["environmentId"];
  workspaceRoot: string;
  brainLoading: boolean;
  brainContents: string | null;
  onCreated: () => void;
  onImport: (prompt: string) => void;
}) {
  const canWriteFiles = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const writeCompanyBrain = useWriteCompanyBrain();
  const [creating, setCreating] = useState(false);

  const createBrain = async (): Promise<boolean> => {
    setCreating(true);
    const written = await writeCompanyBrain({
      environmentId: props.environmentId,
      workspaceRoot: props.workspaceRoot,
    });
    setCreating(false);
    if (written) props.onCreated();
    return written;
  };

  // The agent fills the starter headings, so a missing brain gets them first.
  const importBrain = async (source: BrainSource) => {
    if (props.brainContents === null && !(await createBrain())) return;
    props.onImport(buildBrainImportPrompt(source));
  };

  const importForm =
    props.brainContents === null || isStarterBrain(props.brainContents) ? (
      <ImportBrainForm disabled={!canWriteFiles || creating} onImport={importBrain} />
    ) : null;

  return (
    <section aria-labelledby="company-hub-brain" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="company-hub-brain" className="text-sm font-medium text-muted-foreground">
          Company brain
        </h2>
        <span className="text-xs text-muted-foreground">{COMPANY_DIR}/</span>
      </div>
      {props.brainLoading ? null : props.brainContents !== null ? (
        <>
          {importForm}
          <div
            className={cn(
              "rounded-xl border border-border/60 bg-card px-4 py-3",
              props.brainContents.trim().length === 0 && "text-muted-foreground",
            )}
          >
            <ChatMarkdown
              text={props.brainContents}
              cwd={props.workspaceRoot}
              environmentId={props.environmentId}
            />
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70">
          <Empty>
            <EmptyHeader>
              <BookOpenIcon aria-hidden className="size-5 text-muted-foreground" />
              <EmptyTitle>No company brain yet</EmptyTitle>
              <EmptyDescription>
                Who you are, who you sell to, your voice, and your channels, in {COMPANY_DIR}/.
                Every agent reads it before it starts work.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              size="sm"
              disabled={!canWriteFiles || creating}
              onClick={() => void createBrain()}
            >
              Create company brain
            </Button>
          </Empty>
          {importForm}
        </div>
      )}
    </section>
  );
}

function ImportBrainForm(props: {
  disabled: boolean;
  onImport: (source: BrainSource) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const source = parseBrainSource(value);
  const invalid = value.trim().length > 0 && source === null;

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (source) void props.onImport(source);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Already have a company brain?
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          size="sm"
          placeholder="acme.com, github.com/acme/brain, or a Supabase project URL"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
        />
        <Button type="submit" size="sm" disabled={props.disabled || source === null}>
          <DownloadIcon aria-hidden />
          Import
        </Button>
      </div>
      <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid
          ? "Paste a website, a GitHub repo, or a Supabase project URL."
          : source
            ? `Claude reads the ${brainSourceLabel(source)} and fills in ${COMPANY_DIR}/. You review the prompt before it starts.`
            : `Claude reads it and fills in ${COMPANY_DIR}/ for every agent here.`}
      </p>
    </form>
  );
}
