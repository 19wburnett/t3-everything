import type {
  CompanyChannelAccount,
  CompanyMailSecurity,
  CompanyMicrosoftSignInPrompt,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { Check, Copy } from "lucide";
import { ExternalLinkIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureLocalApi } from "~/localApi";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceCode } from "../settings/SourceControlAppSignInSettings";
import { SecretInput } from "../settings/SecretInput";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { CompanyChannelIcon } from "./CompanyChannelIcon";
import {
  ACCOUNT_PROVIDERS,
  type AccountForm,
  accountFormFrom,
  type AccountProvider,
  buildAccountCredentials,
  channelFailure,
  COMPANY_CHANNELS_DOCS_URL,
  describeHealth,
  emptyAccountForm,
  type MailServerForm,
} from "./companyChannels.logic";

export const CHANNELS_SECTION_ID = "company-hub-channels";

interface ChannelTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function CompanyChannelsSection(
  props: ChannelTarget & {
    readonly accounts: ReadonlyArray<CompanyChannelAccount>;
    readonly loading: boolean;
    readonly error: string | null;
  },
) {
  const canManage = useAtomValue(
    companyChannelEnvironment.saveAccount.permissionAtom(props.environmentId),
  );
  const removeAccount = useAtomCommand(companyChannelEnvironment.removeAccount, {
    label: "remove channel account",
  });
  const [dialog, setDialog] = useState<{
    readonly open: boolean;
    readonly account: CompanyChannelAccount | null;
    readonly session: number;
  }>({ open: false, account: null, session: 0 });
  const openDialog = (account: CompanyChannelAccount | null) =>
    setDialog((current) => ({ open: true, account, session: current.session + 1 }));

  const remove = async (account: CompanyChannelAccount) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${account.label}?\nIts saved credentials are deleted from this machine. Drafts for it stay in the outbox.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await removeAccount({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, accountId: account.id },
    });
  };

  return (
    <section aria-labelledby={CHANNELS_SECTION_ID} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={CHANNELS_SECTION_ID} className="text-sm font-medium text-muted-foreground">
          Channels
        </h2>
        <Button
          size="xs"
          variant="ghost-muted"
          className="ml-auto"
          render={<a href={COMPANY_CHANNELS_DOCS_URL} target="_blank" rel="noreferrer noopener" />}
        >
          Setup guide
          <ExternalLinkIcon aria-hidden />
        </Button>
        <Button size="xs" variant="outline" disabled={!canManage} onClick={() => openDialog(null)}>
          <PlusIcon aria-hidden />
          Add account
        </Button>
      </div>
      {props.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : props.loading ? null : props.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect an email inbox or an X, LinkedIn, or Threads account. Agents draft into the
          outbox; only you send.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-card">
          {props.accounts.map((account) => {
            const health = describeHealth(account.health);
            return (
              <li key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3">
                <CompanyChannelIcon kind={account.kind} className="size-4 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.label}</span>
                    {health ? (
                      <Badge variant={health.tone}>
                        {account.health._tag === "error" ? "Not working" : health.text}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{account.address}</span>
                  {account.health._tag === "error" ? (
                    <span className="text-xs text-destructive">{health?.text}</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    variant={health?.reconnect ? "default" : "outline"}
                    disabled={!canManage}
                    onClick={() => openDialog(account)}
                  >
                    {health?.reconnect ? "Reconnect" : "Edit"}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Remove ${account.label}`}
                    disabled={!canManage}
                    onClick={() => void remove(account)}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AccountDialog
        key={dialog.session}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        account={dialog.account}
        environmentId={props.environmentId}
        projectId={props.projectId}
      />
    </section>
  );
}

const PROVIDER_HELP: Record<AccountProvider, ReactNode> = {
  gmail:
    "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords.",
  icloud: "Create an app-specific password at account.apple.com, under Sign-In and Security.",
  fastmail: "Create an app password with IMAP and SMTP access in Settings > Privacy & Security.",
  imap: "Use an app password if your provider offers one. Your provider lists its IMAP and SMTP servers.",
  microsoft:
    "Register an app in the Microsoft Entra admin center, turn on Allow public client flows, and add the Mail.ReadWrite, Mail.Send, User.Read, and offline_access permissions.",
  x: "In the X developer portal, set user authentication to Read and write, then copy the API key and secret and generate an access token and secret. Regenerate tokens made before you chose Read and write.",
  linkedin:
    "Generate a token in the LinkedIn developer portal with the openid, profile, and w_member_social scopes.",
  threads:
    "Generate a Threads user token with threads_basic and threads_content_publish, then exchange it for a long-lived one.",
};

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: CompanyMicrosoftSignInPrompt };

function AccountDialog(
  props: ChannelTarget & {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly account: CompanyChannelAccount | null;
  },
) {
  const editing = props.account;
  const [form, setForm] = useState<AccountForm | null>(() =>
    editing ? accountFormFrom(editing, DateTime.nowUnsafe()) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<SignInState>({ status: "idle" });
  // Bumped by cancel, so a sign-in that settles afterwards leaves the dialog alone.
  const attempt = useRef(0);
  const saveAccount = useAtomCommand(companyChannelEnvironment.saveAccount, {
    reportFailure: false,
  });
  const startSignIn = useAtomCommand(companyChannelEnvironment.startMicrosoftSignIn, {
    reportFailure: false,
  });
  const waitForSignIn = useAtomCommand(companyChannelEnvironment.waitForMicrosoftSignIn, {
    reportFailure: false,
  });
  const cancelSignIn = useAtomCommand(companyChannelEnvironment.cancelMicrosoftSignIn, {
    reportFailure: false,
  });
  const target = { environmentId: props.environmentId };
  const update = (patch: Partial<AccountForm>) =>
    setForm((current) => (current === null ? current : { ...current, ...patch }));
  const provider = ACCOUNT_PROVIDERS.find((entry) => entry.id === form?.provider);
  const labelOf = (current: AccountForm) =>
    current.label.trim() || current.address.trim() || provider?.label || "Account";

  const close = () => {
    if (signIn.status !== "idle") {
      attempt.current += 1;
      void cancelSignIn({ ...target, input: { projectId: props.projectId } });
    }
    setSignIn({ status: "idle" });
    props.onOpenChange(false);
  };

  const finish = (account: CompanyChannelAccount) => {
    toastManager.add({
      type: "success",
      title: editing ? `${account.label} updated` : `${account.label} connected`,
    });
    props.onOpenChange(false);
  };

  const save = async () => {
    if (form === null) return;
    const built = buildAccountCredentials(form, editing !== null);
    if ("missing" in built) return;
    setSaving(true);
    setError(null);
    const result = await saveAccount({
      ...target,
      input: {
        projectId: props.projectId,
        ...(editing ? { accountId: editing.id } : {}),
        label: labelOf(form),
        credentials: built.credentials,
      },
    });
    setSaving(false);
    if (result._tag === "Success") finish(result.value);
    else setError(channelFailure(result.cause).message);
  };

  const signInWithMicrosoft = async () => {
    if (form === null) return;
    setError(null);
    setSignIn({ status: "starting" });
    const mine = ++attempt.current;
    const tenant = form.tenant.trim();
    const started = await startSignIn({
      ...target,
      input: {
        projectId: props.projectId,
        ...(editing ? { accountId: editing.id } : {}),
        label: labelOf(form),
        clientId: form.clientId.trim(),
        ...(tenant.length > 0 ? { tenant } : {}),
      },
    });
    if (attempt.current !== mine) return;
    if (started._tag !== "Success") {
      setSignIn({ status: "idle" });
      setError(channelFailure(started.cause).message);
      return;
    }
    setSignIn({ status: "waiting", prompt: started.value });
    const finished = await waitForSignIn({ ...target, input: { projectId: props.projectId } });
    if (attempt.current !== mine) return;
    setSignIn({ status: "idle" });
    if (finished._tag === "Success") finish(finished.value);
    else {
      const failure = channelFailure(finished.cause);
      if (failure.reason !== "sign_in_cancelled") setError(failure.message);
    }
  };

  const built = form === null ? null : buildAccountCredentials(form, editing !== null);
  const missing = built !== null && "missing" in built ? built.missing : [];
  const isMicrosoft = form?.provider === "microsoft";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
        else props.onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${editing.label}` : form ? `Add ${provider?.label}` : "Add account"}
          </DialogTitle>
          <DialogDescription>
            {form === null
              ? "Credentials stay on this company's machine and are never shown again after you save."
              : PROVIDER_HELP[form.provider]}{" "}
            <a
              href={COMPANY_CHANNELS_DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Setup guide
            </a>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {form === null ? (
            <ProviderPicker
              onPick={(picked) => setForm(emptyAccountForm(picked, DateTime.nowUnsafe()))}
            />
          ) : signIn.status === "waiting" ? (
            <MicrosoftDeviceCode prompt={signIn.prompt} />
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (isMicrosoft && editing === null) void signInWithMicrosoft();
                else void save();
              }}
            >
              <AccountFields form={form} editing={editing !== null} update={update} />
              <button type="submit" hidden />
            </form>
          )}
          {error !== null ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          {form !== null && editing === null && signIn.status === "idle" ? (
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setForm(null)}>
              Back
            </Button>
          ) : null}
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {form === null || signIn.status === "waiting" ? null : isMicrosoft ? (
            <>
              {editing ? (
                <Button variant="outline" disabled={saving} onClick={() => void save()}>
                  Save name
                </Button>
              ) : null}
              <Button
                disabled={form.clientId.trim().length === 0 || signIn.status === "starting"}
                onClick={() => void signInWithMicrosoft()}
              >
                {signIn.status === "starting" ? <Spinner /> : null}
                {editing ? "Sign in again" : "Sign in with Microsoft"}
              </Button>
            </>
          ) : (
            <Button
              disabled={saving || missing.length > 0}
              title={missing.length > 0 ? `Enter the ${missing.join(", ")}` : undefined}
              onClick={() => void save()}
            >
              {saving ? <Spinner /> : null}
              {saving ? "Checking" : editing ? "Save" : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProviderPicker(props: { readonly onPick: (provider: AccountProvider) => void }) {
  const groups = [
    { title: "Email", providers: ACCOUNT_PROVIDERS.filter((entry) => entry.kind === "email") },
    { title: "Social", providers: ACCOUNT_PROVIDERS.filter((entry) => entry.kind !== "email") },
  ];
  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <div key={group.title} className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">{group.title}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.providers.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => props.onPick(entry.id)}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <CompanyChannelIcon kind={entry.kind} className="size-4 shrink-0" />
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly help?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.help ? <p className="text-xs text-muted-foreground">{props.help}</p> : null}
    </div>
  );
}

function SecretField(props: {
  readonly id: string;
  readonly label: string;
  readonly help?: string;
  readonly editing: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field id={props.id} label={props.label} {...(props.help ? { help: props.help } : {})}>
      <SecretInput
        id={props.id}
        configured={props.editing}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

function AccountFields(props: {
  readonly form: AccountForm;
  readonly editing: boolean;
  readonly update: (patch: Partial<AccountForm>) => void;
}) {
  const { form, editing, update } = props;
  const label = (
    <Field id="channel-label" label="Label">
      <Input
        id="channel-label"
        value={form.label}
        placeholder={
          form.provider === "x" || form.provider === "linkedin" ? "Company page" : "Sales inbox"
        }
        onChange={(event) => update({ label: event.target.value })}
      />
    </Field>
  );

  switch (form.provider) {
    case "microsoft":
      return (
        <>
          {label}
          <Field
            id="channel-client-id"
            label="Application (client) ID"
            help="From your app registration's Overview page."
          >
            <Input
              id="channel-client-id"
              font="mono"
              value={form.clientId}
              onChange={(event) => update({ clientId: event.target.value })}
            />
          </Field>
          <Field
            id="channel-tenant"
            label="Tenant (optional)"
            help="Leave blank for common, unless your organization requires its own tenant ID."
          >
            <Input
              id="channel-tenant"
              font="mono"
              placeholder="common"
              value={form.tenant}
              onChange={(event) => update({ tenant: event.target.value })}
            />
          </Field>
        </>
      );
    case "x":
      return (
        <>
          {label}
          <div className="grid gap-4 sm:grid-cols-2">
            <SecretField
              id="channel-x-key"
              label="API key"
              editing={editing}
              value={form.consumerKey}
              onChange={(consumerKey) => update({ consumerKey })}
            />
            <SecretField
              id="channel-x-secret"
              label="API key secret"
              editing={editing}
              value={form.consumerSecret}
              onChange={(consumerSecret) => update({ consumerSecret })}
            />
            <SecretField
              id="channel-x-token"
              label="Access token"
              editing={editing}
              value={form.accessToken}
              onChange={(accessToken) => update({ accessToken })}
            />
            <SecretField
              id="channel-x-token-secret"
              label="Access token secret"
              editing={editing}
              value={form.accessTokenSecret}
              onChange={(accessTokenSecret) => update({ accessTokenSecret })}
            />
          </div>
        </>
      );
    case "linkedin":
    case "threads":
      return (
        <>
          {label}
          <SecretField
            id="channel-token"
            label={form.provider === "threads" ? "Long-lived access token" : "Access token"}
            editing={editing}
            value={form.accessToken}
            onChange={(accessToken) => update({ accessToken })}
          />
          <Field
            id="channel-token-expiry"
            label="Token expires on"
            help={
              form.provider === "linkedin"
                ? "LinkedIn shows the date when it issues the token. You're warned a week before."
                : "Long-lived tokens last 60 days and renew while you use the account."
            }
          >
            <Input
              id="channel-token-expiry"
              type="date"
              value={form.tokenExpiresOn}
              onChange={(event) => update({ tokenExpiresOn: event.target.value })}
            />
          </Field>
        </>
      );
    default:
      return (
        <>
          {label}
          <Field id="channel-address" label="Email address">
            <Input
              id="channel-address"
              type="email"
              autoComplete="off"
              value={form.address}
              onChange={(event) => update({ address: event.target.value })}
            />
          </Field>
          <SecretField
            id="channel-password"
            label="App password"
            help="Not your normal password."
            editing={editing}
            value={form.password}
            onChange={(password) => update({ password })}
          />
          {form.provider === "imap" ? (
            <>
              <Field
                id="channel-username"
                label="Username (optional)"
                help="Defaults to the email address."
              >
                <Input
                  id="channel-username"
                  autoComplete="off"
                  value={form.username}
                  onChange={(event) => update({ username: event.target.value })}
                />
              </Field>
              <MailServerFields
                id="channel-imap"
                label="IMAP server"
                server={form.imap}
                onChange={(imap) => update({ imap })}
              />
              <MailServerFields
                id="channel-smtp"
                label="SMTP server"
                server={form.smtp}
                onChange={(smtp) => update({ smtp })}
              />
            </>
          ) : null}
        </>
      );
  }
}

const SECURITY_LABELS: Record<CompanyMailSecurity, string> = { tls: "TLS", starttls: "STARTTLS" };

function MailServerFields(props: {
  readonly id: string;
  readonly label: string;
  readonly server: MailServerForm;
  readonly onChange: (server: MailServerForm) => void;
}) {
  const { server } = props;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`${props.id}-host`}>{props.label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-2">
        <Input
          id={`${props.id}-host`}
          placeholder="mail.example.com"
          value={server.host}
          onChange={(event) => props.onChange({ ...server, host: event.target.value })}
        />
        <Input
          aria-label={`${props.label} port`}
          inputMode="numeric"
          value={server.port}
          onChange={(event) => props.onChange({ ...server, port: event.target.value })}
        />
        <Select
          value={server.security}
          onValueChange={(value) => {
            if (value !== null) props.onChange({ ...server, security: value });
          }}
        >
          <SelectTrigger aria-label={`${props.label} security`} className="min-w-0">
            <SelectValue>{SECURITY_LABELS[server.security]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(SECURITY_LABELS) as CompanyMailSecurity[]).map((security) => (
              <SelectItem key={security} value={security}>
                {SECURITY_LABELS[security]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

const expiryTime = (expiresAt: DateTime.Utc) =>
  new Date(DateTime.toEpochMillis(expiresAt)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

function MicrosoftDeviceCode(props: { readonly prompt: CompanyMicrosoftSignInPrompt }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "sign-in code",
  });
  const { prompt } = props;
  return (
    <div className="grid justify-items-center gap-4 py-2 text-center">
      <div className="flex items-center gap-2">
        <DeviceCode code={prompt.userCode} />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy code"
          onClick={() => copyToClipboard(prompt.userCode, undefined)}
        >
          <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
        </Button>
      </div>
      <Button
        size="sm"
        render={<a href={prompt.verificationUri} target="_blank" rel="noreferrer noopener" />}
        onClick={() => copyToClipboard(prompt.userCode, undefined)}
      >
        Copy code & open Microsoft
        <ExternalLinkIcon aria-hidden className="size-3.5" />
      </Button>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-warning" />
        Waiting for approval · code expires at {expiryTime(prompt.expiresAt)}
      </p>
    </div>
  );
}
