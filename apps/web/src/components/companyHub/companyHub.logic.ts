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

export type WorkTaskTarget =
  | { readonly kind: "bridge"; readonly agent: (typeof BRIDGE_AGENTS)[number] }
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
];
