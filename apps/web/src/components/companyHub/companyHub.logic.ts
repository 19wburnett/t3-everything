import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

/** Lives in the project root so every agent, coding or not, can read it like any other file. */
export const COMPANY_DIR = "company";

/** Hosted work agents (Muse, Grok Bot) are instances of this driver; everything else codes. */
export const AGENT_BRIDGE_DRIVER = "agentBridge";

export type AgentLaneKind = "work" | "code";

export interface AgentLane<T> {
  /** Bridge lanes are per instance, since Muse and Grok Bot share one driver; code lanes are per driver. */
  readonly key: string;
  readonly kind: AgentLaneKind;
  readonly threads: ReadonlyArray<T>;
}

/** Work lanes first, then the busiest lanes; threads newest first. */
export function groupThreadsByAgent<T extends { readonly updatedAt: string }>(
  threads: ReadonlyArray<T>,
  providerOf: (thread: T) => { readonly driverKind: string; readonly instanceId: string },
): ReadonlyArray<AgentLane<T>> {
  const lanes = new Map<string, { kind: AgentLaneKind; threads: Array<T> }>();
  for (const thread of threads) {
    const { driverKind, instanceId } = providerOf(thread);
    const kind = driverKind === AGENT_BRIDGE_DRIVER ? "work" : "code";
    const key = kind === "work" ? instanceId : driverKind;
    const lane = lanes.get(key);
    if (lane) lane.threads.push(thread);
    else lanes.set(key, { kind, threads: [thread] });
  }
  return [...lanes]
    .map(([key, lane]) => ({
      key,
      kind: lane.kind,
      threads: lane.threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .toSorted(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "work" ? -1 : 1) ||
        b.threads.length - a.threads.length ||
        a.key.localeCompare(b.key),
    );
}

const BRIDGE_AGENTS = [
  { instanceId: "museBot", displayName: "Muse" },
  { instanceId: "grokBot", displayName: "Grok Bot" },
] as const;

export type BridgeAgent = (typeof BRIDGE_AGENTS)[number];

export type WorkTaskTarget =
  | { readonly kind: "bridge"; readonly agent: BridgeAgent }
  | { readonly kind: "coding"; readonly provider: "claude" | "codex" };

const MUSE: WorkTaskTarget = { kind: "bridge", agent: BRIDGE_AGENTS[0] };
const GROK_BOT: WorkTaskTarget = { kind: "bridge", agent: BRIDGE_AGENTS[1] };

export interface WorkTaskPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly target: WorkTaskTarget;
  readonly prompt: string;
}

export const WORK_TASK_PRESETS: ReadonlyArray<WorkTaskPreset> = [
  {
    id: "outbound",
    label: "Outbound",
    description: "Find leads and draft a sequence",
    target: MUSE,
    prompt:
      "Build an outbound campaign. Find 20 prospects that match our ideal customer profile, then draft a 3-step email sequence for them. Save the list and drafts under company/outbound/.",
  },
  {
    id: "email",
    label: "Email",
    description: "Triage the inbox and draft replies",
    target: MUSE,
    prompt:
      "Triage my inbox for the accounts in company/CHANNELS.md. Group what needs me, draft replies in our voice, and do not send anything until I approve.",
  },
  {
    id: "social",
    label: "Social",
    description: "Draft this week's posts",
    target: GROK_BOT,
    prompt:
      "Draft this week's social posts for the channels in company/CHANNELS.md. Match our voice, give 3 options per post, and do not publish until I approve.",
  },
  {
    id: "customer-success",
    label: "Customer success",
    description: "Review open customer issues",
    target: GROK_BOT,
    prompt:
      "Review open customer conversations and support requests. Summarize who needs a reply, draft the replies, and flag anything that needs a product or code change.",
  },
  {
    id: "growth",
    label: "Growth",
    description: "Find the next experiment",
    target: MUSE,
    prompt:
      "Look at where we are and propose the three growth experiments with the best expected return this month. For each, give the hypothesis, the channel, and the first concrete step.",
  },
  {
    id: "code",
    label: "Code",
    description: "Ship a change to the codebase",
    target: { kind: "coding", provider: "claude" },
    prompt: "",
  },
];

/** The bridge hands the company brain to hosted agents itself; coding agents read it from disk. */
export function buildWorkTaskPrompt(preset: WorkTaskPreset, hasCompanyBrain: boolean): string {
  if (preset.prompt.length === 0) return "";
  return hasCompanyBrain && preset.target.kind === "coding"
    ? `Read the files in ${COMPANY_DIR}/ first for who we are, our voice, and our channels.\n\n${preset.prompt}`
    : preset.prompt;
}

/** Null selection means the user's default model applies, with the warning shown. */
export function resolveWorkTaskModelSelection(
  providers: Parameters<typeof resolvePromptLinkModelSelection>[0],
  target: WorkTaskTarget,
): { readonly selection: ModelSelection } | { readonly warning: string } {
  if (target.kind === "coding") {
    const resolved = resolvePromptLinkModelSelection(providers, {
      provider: target.provider,
      model: null,
    });
    return resolved ?? { warning: `${target.provider} isn't set up on this machine.` };
  }
  const { instanceId, displayName } = target.agent;
  return providers.some(
    (provider) =>
      provider.instanceId === instanceId &&
      provider.driver === AGENT_BRIDGE_DRIVER &&
      provider.enabled,
  )
    ? { selection: { instanceId: ProviderInstanceId.make(instanceId), model: "default" } }
    : { warning: `${displayName} isn't connected on this machine.` };
}

export function connectedBridgeAgents(
  providers: Parameters<typeof resolvePromptLinkModelSelection>[0],
): ReadonlyArray<BridgeAgent> {
  return BRIDGE_AGENTS.filter(
    (agent) => "selection" in resolveWorkTaskModelSelection(providers, { kind: "bridge", agent }),
  );
}

const HAND_OFF_TARGETS = [
  { provider: "claude", label: "Claude" },
  { provider: "codex", label: "Codex" },
] as const;

export type HandOffTarget = (typeof HAND_OFF_TARGETS)[number];

/** A hosted agent's thread can move to a coding agent, which has the files, browser, and accounts. */
export function resolveHandOff(
  providers: ReadonlyArray<
    Parameters<typeof resolvePromptLinkModelSelection>[0][number] & {
      readonly displayName?: string | undefined;
    }
  >,
  instanceId: string,
): { readonly agentName: string; readonly targets: ReadonlyArray<HandOffTarget> } | null {
  const agent = providers.find(
    (provider) => provider.instanceId === instanceId && provider.driver === AGENT_BRIDGE_DRIVER,
  );
  if (!agent) return null;
  const targets = HAND_OFF_TARGETS.filter(
    (target) =>
      "selection" in
      resolveWorkTaskModelSelection(providers, { kind: "coding", provider: target.provider }),
  );
  return targets.length === 0 ? null : { agentName: agent.displayName ?? "The agent", targets };
}

export function buildHandOffPrompt(threadReference: string, agentName: string): string {
  return `${threadReference}\n\n${agentName} started this work in the thread above. Read it, then carry the work through here.`;
}

export const COMPANY_BRAIN_TEMPLATES: ReadonlyArray<{
  readonly relativePath: string;
  readonly contents: string;
}> = [
  {
    relativePath: `${COMPANY_DIR}/BRAIN.md`,
    contents: `# Company brain

What every agent should know before it works on this company.

## What we do

## Who we sell to

## Voice

## What is off limits
`,
  },
  {
    relativePath: `${COMPANY_DIR}/CHANNELS.md`,
    contents: `# Channels

The accounts agents work through. Credentials live in each agent's own setup, never here.

## Email

-

## Social

- X:
- LinkedIn:

## Customer support

-
`,
  },
  {
    relativePath: `${COMPANY_DIR}/DESIGN.md`,
    contents: `# Design

The brand every page, deck, document and graphic follows.

## Colors

- Primary:
- Accent:
- Background:
- Text:

## Type

- Headings:
- Body:

## Logo

- File:
- Clear space and minimum size:

## Look and feel

## Never
`,
  },
];

export type BrainSource =
  | { readonly kind: "github"; readonly url: string; readonly repository: string }
  | { readonly kind: "supabase"; readonly url: string }
  | { readonly kind: "website"; readonly url: string };

const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/** Accepts a site, a GitHub repo (URL or owner/repo), or a Supabase project or dashboard URL. */
export function parseBrainSource(input: string): BrainSource | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (GITHUB_SHORTHAND.test(trimmed) && !trimmed.split("/")[0]!.includes(".")) {
    return { kind: "github", url: `https://github.com/${trimmed}`, repository: trimmed };
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "github.com") {
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (owner && repo) {
      const repository = `${owner}/${repo.replace(/\.git$/, "")}`;
      return { kind: "github", url: `https://github.com/${repository}`, repository };
    }
  }
  if (host.endsWith(".supabase.co") || host === "supabase.com" || host.endsWith(".supabase.com")) {
    return { kind: "supabase", url: url.href };
  }
  return { kind: "website", url: url.href };
}

export function brainSourceLabel(source: BrainSource): string {
  switch (source.kind) {
    case "github":
      return `GitHub repo ${source.repository}`;
    case "supabase":
      return "Supabase project";
    case "website":
      return `Website ${new URL(source.url).hostname}`;
  }
}

/** A coding agent does the import, since it already has git, a browser, and MCP tools like Supabase's. */
export function buildBrainImportPrompt(source: BrainSource): string {
  const read = {
    github: `Our company brain lives in the GitHub repository ${source.url}. Clone it into a temporary directory outside this project (use gh if it is private) and read all of it.`,
    supabase: `Our company brain lives in the Supabase project at ${source.url}. Use the Supabase MCP tools or CLI to find the tables and storage that describe the company and read them. Only read; change nothing in that project.`,
    website: `Our company brain is the website ${source.url}. Read it, along with the pages it links to that describe the company, such as about, product, pricing, docs, and blog.`,
  }[source.kind];
  return `${read}

Then bring what you learn into ${COMPANY_DIR}/ so every agent here can use it:
- Fill in ${COMPANY_DIR}/BRAIN.md under its existing headings: what we do, who we sell to, our voice, and what is off limits.
- Fill in ${COMPANY_DIR}/CHANNELS.md with the email, social, and support accounts you find. Never copy credentials or keys.
- Save longer reference material worth keeping (positioning, FAQs, pricing, playbooks) as separate Markdown files in ${COMPANY_DIR}/.
- End BRAIN.md with a "## Source" section linking ${source.url}, so the brain can be refreshed later.

If you can't get access, tell me exactly what you need instead of guessing.`;
}

/** The starter brain is still untouched, so importing one replaces nothing a person wrote. */
export function isStarterBrain(contents: string): boolean {
  return contents.trim() === COMPANY_BRAIN_TEMPLATES[0]!.contents.trim();
}
