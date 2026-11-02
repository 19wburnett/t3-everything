# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Environments**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Sharing & access** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Muse and Grok Bot as threads

Meta's Muse and xAI's Grok Bot run in the cloud and cannot be called by other
apps, so T3 Code lets them pick up work instead. **Muse** and **Grok Bot** are
listed as providers. Once a bot is connected, a company's hub shows **New Muse
thread** and **New Grok Bot thread**, and the command palette has the same
actions. The thread stays running until the bot checks in, does the work, and
replies. Until a bot has checked in, its provider shows that it is waiting for
it to connect.

1. Give the environment an internet address with T3 Connect (`t3 up`; see
   [Remote access](./remote-access.md)) and copy its MCP URL as described
   above.
2. Connect the bot over OAuth. In the Grok app, add a custom connector with the
   MCP URL. Muse connects to the MCP URL as a remote MCP server.
3. Approve the sign-in with **Supervised** or higher. A read-only bot cannot
   collect or answer messages.
4. Give the bot a routine, for example: "Every 15 minutes, call
   `t3_bridge_inbox` with agent `museBot`. Do each task. Reply with
   `t3_bridge_reply`, and set done when finished. Never answer with
   `t3_thread_send`." Use `grokBot` for Grok Bot. T3 refuses a bot's
   `t3_thread_send` to its own threads, since that would post as you.
   A bot only sees new threads when it checks in, so a shorter schedule
   answers sooner. Each check-in is a run of the bot, though, and uses its own
   usage even when there is nothing to do. A running thread shows when the bot
   last checked in.

Each message reaches the bot together with the project's `company/BRAIN.md`
and `company/CHANNELS.md` when they exist. If the bot collects a message but
does not reply on that thread within 10 minutes, the message is handed to it
again, so work is not lost when a bot run fails partway. Messages you send
while a thread is running join its open task. Before a bot sends, publishes,
or pays for something, it can ask with `t3_bridge_request_approval`, and an
approval card appears in the thread. Approve or Decline it, adding a note if you
decline. The bot gets your decision the next time it checks in, so keep its
schedule short for anything waiting on you. Stop ends the task, and the bot's
later replies to it are refused.

To see a conversation you had in the bot's own app, ask the bot to share it
with T3 Code, for example: "Share this conversation to T3 Everything with
`t3_bridge_share`, in project Bitty Construction." It appears as a thread on
that bot, and the bot does not receive it as new work. The bot gets a thread
id back; asking it to share again adds only the newer messages to the same
thread. To copy chats in regularly, add that to the bot's routine. The bot
decides what to share, so a chat it was not asked to share does not appear.
Sharing also hands the bot any new messages waiting for it, so a bot that shares
often answers sooner.

To have a coding agent finish what a bot started, choose **Send to Claude** or
**Send to Codex** from the thread's menu or the command palette. A new thread
opens in the same project with a link to the bot's thread, which the coding agent
reads before it starts. Add instructions before you send it.

Each task carries its `projectId`. With it, a bot can read the company's inbox
with `t3_company_inbox` and `t3_company_message`, and draft replies and posts
with `t3_company_draft`; you send them from the Company hub. See
[Company channels](./company-channels.md).

Open tasks survive a restart of the environment: each one reopens in its
thread with its unread messages and approval cards. To bridge another hosted
agent, add an **Agent bridge** provider in **Settings → Providers → Add
provider**. A bot that names an unknown agent is told the valid ids.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
