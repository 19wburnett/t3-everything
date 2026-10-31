/** Lives in the project root so every agent, coding or not, can read it like any other file. */
export const COMPANY_DIR = "company";

/** Muse and Grok run growth, outreach, email, and support; everything else is a coding agent. */
const WORK_DRIVER_KINDS: ReadonlySet<string> = new Set(["muse", "grok"]);

export type AgentLaneKind = "work" | "code";

function agentLaneKind(driverKind: string): AgentLaneKind {
  return WORK_DRIVER_KINDS.has(driverKind) ? "work" : "code";
}

export interface AgentLane<T> {
  readonly driverKind: string;
  readonly kind: AgentLaneKind;
  readonly threads: ReadonlyArray<T>;
}

/** Work lanes first, then the busiest lanes; threads newest first. */
export function groupThreadsByAgent<T extends { readonly updatedAt: string }>(
  threads: ReadonlyArray<T>,
  driverKindOf: (thread: T) => string,
): ReadonlyArray<AgentLane<T>> {
  const byDriver = new Map<string, Array<T>>();
  for (const thread of threads) {
    const driverKind = driverKindOf(thread);
    const lane = byDriver.get(driverKind);
    if (lane) lane.push(thread);
    else byDriver.set(driverKind, [thread]);
  }
  return [...byDriver]
    .map(([driverKind, laneThreads]) => ({
      driverKind,
      kind: agentLaneKind(driverKind),
      threads: laneThreads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .toSorted(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "work" ? -1 : 1) ||
        b.threads.length - a.threads.length ||
        a.driverKind.localeCompare(b.driverKind),
    );
}

export interface WorkTaskPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** A prompt-link provider name, resolved against the environment's enabled instances. */
  readonly provider: "muse" | "grok" | "claude" | "codex";
  readonly prompt: string;
}

export const WORK_TASK_PRESETS: ReadonlyArray<WorkTaskPreset> = [
  {
    id: "outbound",
    label: "Outbound",
    description: "Find leads and draft a sequence",
    provider: "muse",
    prompt:
      "Build an outbound campaign. Find 20 prospects that match our ideal customer profile, then draft a 3-step email sequence for them. Save the list and drafts under company/outbound/.",
  },
  {
    id: "email",
    label: "Email",
    description: "Triage the inbox and draft replies",
    provider: "muse",
    prompt:
      "Triage my inbox for the accounts in company/CHANNELS.md. Group what needs me, draft replies in our voice, and do not send anything until I approve.",
  },
  {
    id: "social",
    label: "Social",
    description: "Draft this week's posts",
    provider: "grok",
    prompt:
      "Draft this week's social posts for the channels in company/CHANNELS.md. Match our voice, give 3 options per post, and do not publish until I approve.",
  },
  {
    id: "customer-success",
    label: "Customer success",
    description: "Review open customer issues",
    provider: "grok",
    prompt:
      "Review open customer conversations and support requests. Summarize who needs a reply, draft the replies, and flag anything that needs a product or code change.",
  },
  {
    id: "growth",
    label: "Growth",
    description: "Find the next experiment",
    provider: "muse",
    prompt:
      "Look at where we are and propose the three growth experiments with the best expected return this month. For each, give the hypothesis, the channel, and the first concrete step.",
  },
  {
    id: "code",
    label: "Code",
    description: "Ship a change to the codebase",
    provider: "claude",
    prompt: "",
  },
];

/** Points the agent at the company brain; coding prompts stay as the user writes them. */
export function buildWorkTaskPrompt(preset: WorkTaskPreset, hasCompanyBrain: boolean): string {
  if (preset.prompt.length === 0) return "";
  return hasCompanyBrain
    ? `Read the files in ${COMPANY_DIR}/ first for who we are, our voice, and our channels.\n\n${preset.prompt}`
    : preset.prompt;
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
