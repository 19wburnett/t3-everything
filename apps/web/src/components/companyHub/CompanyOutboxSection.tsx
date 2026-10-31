import type {
  CompanyChannelAccount,
  CompanyDraft,
  CompanyOutbox,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { ExternalLinkIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { CompanyChannelIcon } from "./CompanyChannelIcon";
import {
  CHANNEL_NAMES,
  channelFailure,
  firstLine,
  parseAddressList,
  postLength,
} from "./companyChannels.logic";

interface OutboxTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const STATUS_BADGES = {
  draft: { variant: "secondary", label: "Draft" },
  sent: { variant: "success", label: "Sent" },
  failed: { variant: "error", label: "Failed" },
} as const;

export function CompanyOutboxSection(
  props: OutboxTarget & {
    readonly outbox: CompanyOutbox | null;
    readonly error: string | null;
    readonly accounts: ReadonlyArray<CompanyChannelAccount>;
    readonly editing: CompanyDraft | null;
    readonly onEdit: (draft: CompanyDraft | null) => void;
  },
) {
  const canWrite = useAtomValue(
    companyChannelEnvironment.saveDraft.permissionAtom(props.environmentId),
  );
  const saveDraft = useAtomCommand(companyChannelEnvironment.saveDraft, {
    label: "create draft",
  });
  const accountOf = (draft: CompanyDraft) =>
    props.accounts.find((account) => account.id === draft.account);

  const newDraft = async (account: CompanyChannelAccount) => {
    const saved = await saveDraft({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        draft: { channel: account.kind, accountId: account.id, text: "" },
      },
    });
    if (saved._tag === "Success") props.onEdit(saved.value);
  };

  const drafts = props.outbox?.drafts ?? [];
  const malformed = props.outbox?.malformed ?? [];

  return (
    <section aria-labelledby="company-hub-outbox" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="company-hub-outbox" className="text-sm font-medium text-muted-foreground">
          Outbox
        </h2>
        {props.accounts.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="outline" className="ml-auto" disabled={!canWrite} />
              }
            >
              <PlusIcon aria-hidden />
              New draft
            </MenuTrigger>
            <MenuPopup align="end">
              {props.accounts.map((account) => (
                <MenuItem key={account.id} onClick={() => void newDraft(account)}>
                  <CompanyChannelIcon kind={account.kind} />
                  {account.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {props.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : props.outbox === null ? null : drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No drafts. Agents add them here with t3_company_draft, and nothing goes out until you send
          it.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-card">
          {drafts.map((draft) => {
            const status = STATUS_BADGES[draft.status];
            const preview =
              draft.channel === "email"
                ? draft.subject || firstLine(draft.body)
                : firstLine(draft.body);
            return (
              <li key={draft.id}>
                <button
                  type="button"
                  onClick={() => props.onEdit(draft)}
                  className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <CompanyChannelIcon kind={draft.channel} className="size-4" />
                  <span
                    className={cn(
                      "truncate text-sm",
                      preview.length === 0 && "text-muted-foreground",
                    )}
                  >
                    {preview || "Empty draft"}
                  </span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <span className="col-start-2 col-end-4 truncate text-xs text-muted-foreground">
                    {accountOf(draft)?.label ?? draft.account} · {draft.createdBy} ·{" "}
                    {formatRelativeTimeLabel(DateTime.formatIso(draft.sentAt ?? draft.createdAt))}
                    {draft.status === "failed" && draft.error ? ` · ${draft.error}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {malformed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            <span>These outbox files could not be read as drafts:</span>
            <ul className="grid gap-0.5">
              {malformed.map((file) => (
                <li key={file.path}>
                  <code className="font-mono text-xs">{file.path}</code> {file.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {props.editing !== null ? (
        <DraftDialog
          key={props.editing.id}
          environmentId={props.environmentId}
          projectId={props.projectId}
          draft={props.editing}
          account={accountOf(props.editing)}
          canWrite={canWrite}
          onClose={() => props.onEdit(null)}
        />
      ) : null}
    </section>
  );
}

interface DraftFields {
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
}

const fieldsOf = (draft: CompanyDraft): DraftFields => ({
  to: (draft.to ?? []).join(", "),
  cc: (draft.cc ?? []).join(", "),
  subject: draft.subject ?? "",
  body: draft.body,
});

function DraftDialog(
  props: OutboxTarget & {
    readonly draft: CompanyDraft;
    readonly account: CompanyChannelAccount | undefined;
    readonly canWrite: boolean;
    readonly onClose: () => void;
  },
) {
  const canSend = useAtomValue(companyChannelEnvironment.send.permissionAtom(props.environmentId));
  const saveDraft = useAtomCommand(companyChannelEnvironment.saveDraft, { reportFailure: false });
  const sendDraft = useAtomCommand(companyChannelEnvironment.send, { reportFailure: false });
  const discardDraft = useAtomCommand(companyChannelEnvironment.discardDraft, {
    label: "discard draft",
  });
  const [draft, setDraft] = useState(props.draft);
  const [fields, setFields] = useState(() => fieldsOf(props.draft));
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isEmail = draft.channel === "email";
  const sent = draft.status === "sent";
  const editable = !sent && props.canWrite;
  const saved = fieldsOf(draft);
  const dirty =
    fields.body !== saved.body ||
    (isEmail &&
      (fields.to !== saved.to || fields.cc !== saved.cc || fields.subject !== saved.subject));
  const count = postLength(draft.channel, fields.body);
  const tooLong = count !== null && count.length > count.limit;
  const recipients = parseAddressList(fields.to);
  const sendBlocker =
    fields.body.trim().length === 0
      ? "Write something first."
      : tooLong
        ? `${CHANNEL_NAMES[draft.channel]} allows ${count.limit} characters.`
        : isEmail && recipients.length === 0
          ? "Add a recipient."
          : props.account === undefined
            ? "Its account is no longer connected."
            : null;
  const verb = isEmail ? "Send" : "Publish";
  const accountName = props.account
    ? `${props.account.label} (${props.account.address})`
    : draft.account;

  const persist = async () => {
    const result = await saveDraft({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        draftId: draft.id,
        draft: {
          channel: draft.channel,
          accountId: draft.account,
          text: fields.body,
          ...(isEmail
            ? {
                to: recipients,
                cc: parseAddressList(fields.cc),
                subject: fields.subject,
              }
            : {}),
        },
      },
    });
    if (result._tag === "Success") {
      setDraft(result.value);
      setFields(fieldsOf(result.value));
      return true;
    }
    setError(channelFailure(result.cause).message);
    return false;
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    await persist();
    setBusy(null);
  };

  const send = async () => {
    setBusy("send");
    setError(null);
    if (dirty && !(await persist())) {
      setBusy(null);
      setStep("edit");
      return;
    }
    const result = await sendDraft({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, draftId: draft.id },
    });
    setBusy(null);
    setStep("edit");
    if (result._tag !== "Success") {
      setError(channelFailure(result.cause).message);
      return;
    }
    setDraft(result.value);
    if (result.value.status === "sent") {
      toastManager.add({ type: "success", title: isEmail ? "Email sent" : "Post published" });
    } else {
      setError(result.value.error ?? `${verb} failed.`);
    }
  };

  const discard = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Discard this draft?\nIts file in company/outbox is deleted.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await discardDraft({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, draftId: draft.id },
    });
    if (result._tag === "Success") props.onClose();
  };

  const update = (patch: Partial<DraftFields>) =>
    setFields((current) => ({ ...current, ...patch }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy !== "send") props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "confirm"
              ? `${verb} this ${isEmail ? "email" : "post"}?`
              : sent
                ? isEmail
                  ? "Sent email"
                  : "Published post"
                : `${CHANNEL_NAMES[draft.channel]} draft`}
          </DialogTitle>
          <DialogDescription>
            {step === "confirm" ? "This goes out " : ""}From {accountName} · {draft.createdBy}
            {draft.sentAt
              ? ` · sent ${formatRelativeTimeLabel(DateTime.formatIso(draft.sentAt))}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {step === "confirm" ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {isEmail ? (
                <>
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="wrap-anywhere">{recipients.join(", ")}</dd>
                  {parseAddressList(fields.cc).length > 0 ? (
                    <>
                      <dt className="text-muted-foreground">Cc</dt>
                      <dd className="wrap-anywhere">{parseAddressList(fields.cc).join(", ")}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd className="wrap-anywhere">{fields.subject || "(no subject)"}</dd>
                </>
              ) : null}
              <dd className="col-span-2 mt-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 whitespace-pre-wrap wrap-anywhere">
                {fields.body.trim()}
              </dd>
            </dl>
          ) : (
            <div className="grid gap-4">
              {sent && draft.url ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  render={<a href={draft.url} target="_blank" rel="noreferrer noopener" />}
                >
                  View on {CHANNEL_NAMES[draft.channel]}
                  <ExternalLinkIcon aria-hidden />
                </Button>
              ) : null}
              {isEmail ? (
                <>
                  <DraftInput
                    id="draft-to"
                    label="To"
                    value={fields.to}
                    disabled={!editable}
                    onChange={(to) => update({ to })}
                  />
                  <DraftInput
                    id="draft-cc"
                    label="Cc"
                    value={fields.cc}
                    disabled={!editable}
                    onChange={(cc) => update({ cc })}
                  />
                  <DraftInput
                    id="draft-subject"
                    label="Subject"
                    value={fields.subject}
                    disabled={!editable}
                    onChange={(subject) => update({ subject })}
                  />
                </>
              ) : null}
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="draft-body">{isEmail ? "Message" : "Post"}</Label>
                  {count !== null ? (
                    <span
                      className={cn(
                        "text-xs tabular-nums",
                        tooLong ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {count.length} / {count.limit}
                    </span>
                  ) : null}
                </div>
                <Textarea
                  id="draft-body"
                  size="lg"
                  value={fields.body}
                  disabled={!editable}
                  aria-invalid={tooLong || undefined}
                  autoFocus={editable && fields.body.length === 0}
                  onChange={(event) => update({ body: event.target.value })}
                />
              </div>
            </div>
          )}
          {error !== null ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {step === "confirm" ? (
            <>
              <Button variant="outline" disabled={busy !== null} onClick={() => setStep("edit")}>
                Back
              </Button>
              <Button disabled={busy !== null} onClick={() => void send()}>
                {busy === "send" ? <Spinner /> : null}
                {verb} now
              </Button>
            </>
          ) : sent ? (
            <Button variant="outline" onClick={props.onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="ghost-destructive"
                className="sm:mr-auto"
                disabled={!props.canWrite || busy !== null}
                onClick={() => void discard()}
              >
                Discard
              </Button>
              <Button
                variant="outline"
                disabled={!editable || !dirty || busy !== null}
                onClick={() => void save()}
              >
                {busy === "save" ? <Spinner /> : null}
                Save
              </Button>
              <Button
                disabled={!canSend || !editable || sendBlocker !== null || busy !== null}
                title={sendBlocker ?? undefined}
                onClick={() => {
                  setError(null);
                  setStep("confirm");
                }}
              >
                {verb}…
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DraftInput(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}
