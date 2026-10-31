import type {
  CompanyChannelAccount,
  CompanyDraft,
  CompanyInboxMessageSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { CHANNELS_SECTION_ID } from "./CompanyChannelsSection";
import {
  buildReplyAgentPrompt,
  buildReplyDraft,
  channelFailure,
  pickEmailAccount,
} from "./companyChannels.logic";
import type { BridgeAgent } from "./companyHub.logic";

const isoOf = (date: DateTime.Utc | null) => (date === null ? null : DateTime.formatIso(date));

interface InboxProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly accounts: ReadonlyArray<CompanyChannelAccount>;
  readonly agents: ReadonlyArray<BridgeAgent>;
  readonly onAskAgent: (agent: BridgeAgent, prompt: string) => void;
  readonly onDraftCreated: (draft: CompanyDraft) => void;
}

export function CompanyInboxSection(props: InboxProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const account = pickEmailAccount(props.accounts, selectedId);
  return account === null ? null : (
    <InboxBody {...props} account={account} onSelect={setSelectedId} />
  );
}

function InboxBody(
  props: InboxProps & {
    readonly account: CompanyChannelAccount;
    readonly onSelect: (accountId: string) => void;
  },
) {
  const { account } = props;
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const emailAccounts = props.accounts.filter((entry) => entry.kind === "email");
  const inboxAtom = companyChannelEnvironment.inbox({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, accountId: account.id },
  });
  const result = useAtomValue(inboxAtom);
  const inbox = AsyncResult.getOrElse(result, () => null);
  const messages = inbox?.accountId === account.id ? inbox.messages : null;
  const failure = result._tag === "Failure" ? channelFailure(result.cause) : null;

  return (
    <section aria-labelledby="company-hub-inbox" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="company-hub-inbox" className="text-sm font-medium text-muted-foreground">
          Inbox
        </h2>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {emailAccounts.length > 1 ? (
            <Select
              value={account.id}
              onValueChange={(value) => {
                if (value !== null) props.onSelect(value);
              }}
            >
              <SelectTrigger aria-label="Inbox account" size="xs" className="w-auto max-w-56">
                <SelectValue>{account.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {emailAccounts.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <span className="truncate text-xs text-muted-foreground">{account.address}</span>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh inbox"
            disabled={result.waiting}
            onClick={() => appAtomRegistry.refresh(inboxAtom)}
          >
            <RefreshIcon refreshing={result.waiting} />
          </Button>
        </div>
      </div>
      {failure !== null ? (
        <Alert variant="error">
          <AlertDescription>
            {failure.message}
            {failure.reason === "auth_failed" ? (
              <>
                {" "}
                <a href={`#${CHANNELS_SECTION_ID}`} className="underline underline-offset-2">
                  Check the account in Channels
                </a>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : messages === null ? null : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-card">
          {messages.map((message) => (
            <li key={message.id}>
              <InboxRow message={message} onOpen={() => setOpenMessageId(message.id)} />
            </li>
          ))}
        </ul>
      )}
      {openMessageId !== null ? (
        <MessageDialog
          {...props}
          messageId={openMessageId}
          onClose={() => setOpenMessageId(null)}
        />
      ) : null}
    </section>
  );
}

function InboxRow(props: {
  readonly message: CompanyInboxMessageSummary;
  readonly onOpen: () => void;
}) {
  const { message } = props;
  const date = isoOf(message.date);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="grid w-full cursor-pointer grid-cols-[0.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 py-2 text-left outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span
        aria-label={message.unread ? "Unread" : undefined}
        className={message.unread ? "size-2 self-center rounded-full bg-info" : undefined}
      />
      <span
        className={
          message.unread ? "truncate text-sm font-semibold" : "truncate text-sm font-medium"
        }
      >
        {message.from}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {date === null ? "" : formatRelativeTimeLabel(date)}
      </span>
      <span className="col-start-2 col-end-4 truncate text-sm">
        {message.subject || "(no subject)"}
      </span>
      <span className="col-start-2 col-end-4 truncate text-xs text-muted-foreground">
        {message.snippet}
      </span>
    </button>
  );
}

function MessageDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly account: CompanyChannelAccount;
  readonly messageId: string;
  readonly agents: ReadonlyArray<BridgeAgent>;
  readonly onAskAgent: (agent: BridgeAgent, prompt: string) => void;
  readonly onDraftCreated: (draft: CompanyDraft) => void;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(
    companyChannelEnvironment.message({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        accountId: props.account.id,
        messageId: props.messageId,
      },
    }),
  );
  const canDraft = useAtomValue(
    companyChannelEnvironment.saveDraft.permissionAtom(props.environmentId),
  );
  const saveDraft = useAtomCommand(companyChannelEnvironment.saveDraft, {
    label: "draft reply",
  });
  const [drafting, setDrafting] = useState(false);
  const message = AsyncResult.getOrElse(result, () => null);
  const failure = result._tag === "Failure" ? channelFailure(result.cause) : null;
  const date = message === null ? null : isoOf(message.date);

  const draftReply = async () => {
    if (message === null) return;
    setDrafting(true);
    const saved = await saveDraft({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, draft: buildReplyDraft(props.account, message) },
    });
    setDrafting(false);
    if (saved._tag !== "Success") return;
    props.onClose();
    props.onDraftCreated(saved.value);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{message ? message.subject || "(no subject)" : "Message"}</DialogTitle>
          {message ? (
            <DialogDescription render={<div />} className="grid gap-0.5">
              <span>From {message.from}</span>
              {message.to.length > 0 ? <span>To {message.to.join(", ")}</span> : null}
              {message.cc.length > 0 ? <span>Cc {message.cc.join(", ")}</span> : null}
              {date ? <span>{new Date(date).toLocaleString()}</span> : null}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {failure !== null ? (
            <Alert variant="error">
              <AlertDescription>{failure.message}</AlertDescription>
            </Alert>
          ) : message === null ? (
            <Spinner size="md" />
          ) : (
            <p className="text-sm whitespace-pre-wrap wrap-anywhere">{message.text}</p>
          )}
        </DialogPanel>
        <DialogFooter>
          {props.agents.map((agent) => (
            <Button
              key={agent.instanceId}
              variant="outline"
              disabled={message === null}
              onClick={() => {
                if (message === null) return;
                props.onClose();
                props.onAskAgent(agent, buildReplyAgentPrompt(props.account, message));
              }}
            >
              Ask {agent.displayName}
            </Button>
          ))}
          <Button
            disabled={message === null || !canDraft || drafting}
            onClick={() => void draftReply()}
          >
            {drafting ? <Spinner /> : null}
            Draft reply
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
