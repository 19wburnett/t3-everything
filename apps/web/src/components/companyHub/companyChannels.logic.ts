import type {
  CompanyChannelAccount,
  CompanyChannelAccountCredentials,
  CompanyChannelFailure,
  CompanyChannelHealth,
  CompanyChannelKind,
  CompanyDraftContent,
  CompanyEmailPreset,
  CompanyInboxMessageSummary,
  CompanyMailSecurity,
  CompanyMailServer,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export const COMPANY_CHANNELS_DOCS_URL =
  "https://github.com/19wburnett/t4/blob/main/docs/user/company-channels.md";

export const CHANNEL_NAMES: Record<CompanyChannelKind, string> = {
  email: "Email",
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
};

/** Mirrors the server's send check: code points of the trimmed body. */
const POST_LIMITS: Partial<Record<CompanyChannelKind, number>> = {
  x: 280,
  threads: 500,
  linkedin: 3000,
};

export function postLength(
  channel: CompanyChannelKind,
  text: string,
): { readonly length: number; readonly limit: number } | null {
  const limit = POST_LIMITS[channel];
  return limit === undefined ? null : { length: Array.from(text.trim()).length, limit };
}

export type HealthTone = "error" | "warning";

export function describeHealth(
  health: CompanyChannelHealth,
): { readonly tone: HealthTone; readonly text: string; readonly reconnect: boolean } | null {
  switch (health._tag) {
    case "ok":
      return null;
    case "error":
      return { tone: "error", text: health.message, reconnect: true };
    case "expiring":
      return {
        tone: "warning",
        text:
          health.expiresInDays <= 0
            ? "Expires today"
            : `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}`,
        reconnect: false,
      };
    case "expired":
      return { tone: "error", text: "Expired, reconnect", reconnect: true };
  }
}

/** Keeps the user's pick while it exists, else prefers an account that still works. */
export function pickEmailAccount(
  accounts: ReadonlyArray<CompanyChannelAccount>,
  selectedId: string | null,
): CompanyChannelAccount | null {
  const email = accounts.filter((account) => account.kind === "email");
  return (
    email.find((account) => account.id === selectedId) ??
    email.find((account) => account.health._tag === "ok" || account.health._tag === "expiring") ??
    email[0] ??
    null
  );
}

/** The server fills in the recipient, subject, and threading headers from the message. */
export function buildReplyDraft(
  account: CompanyChannelAccount,
  message: Pick<CompanyInboxMessageSummary, "id">,
): CompanyDraftContent {
  return { channel: "email", accountId: account.id, text: "", replyToMessageId: message.id };
}

export function buildReplyAgentPrompt(
  account: CompanyChannelAccount,
  message: Pick<CompanyInboxMessageSummary, "id" | "from" | "subject">,
): string {
  return [
    `Draft a reply to this email in our voice. Read it with t3_company_message (accountId "${account.id}", messageId "${message.id}"), then save the reply with t3_company_draft using replyToMessageId "${message.id}". Do not send it; I will review it in the Company hub.`,
    "",
    `From: ${message.from}`,
    `Subject: ${message.subject || "(no subject)"}`,
  ].join("\n");
}

export function parseAddressList(value: string): ReadonlyArray<string> {
  return value
    .split(/[,;\n]/)
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export function channelFailure(cause: Cause.Cause<unknown>): {
  readonly reason: CompanyChannelFailure | null;
  readonly message: string;
} {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "CompanyChannelError" && "reason" in error && "message" in error) {
      return {
        reason: error.reason as CompanyChannelFailure,
        message: String(error.message),
      };
    }
  }
  return { reason: null, message: error instanceof Error ? error.message : String(error) };
}

export type AccountProvider =
  | Exclude<CompanyEmailPreset, "custom">
  | "imap"
  | "microsoft"
  | "x"
  | "linkedin"
  | "threads";

export const ACCOUNT_PROVIDERS: ReadonlyArray<{
  readonly id: AccountProvider;
  readonly label: string;
  readonly kind: CompanyChannelKind;
}> = [
  { id: "gmail", label: "Gmail / Google Workspace", kind: "email" },
  { id: "microsoft", label: "Outlook / Microsoft 365", kind: "email" },
  { id: "icloud", label: "iCloud", kind: "email" },
  { id: "fastmail", label: "Fastmail", kind: "email" },
  { id: "imap", label: "Other IMAP", kind: "email" },
  { id: "x", label: "X", kind: "x" },
  { id: "linkedin", label: "LinkedIn", kind: "linkedin" },
  { id: "threads", label: "Threads", kind: "threads" },
];

export interface MailServerForm {
  readonly host: string;
  readonly port: string;
  readonly security: CompanyMailSecurity;
}

export interface AccountForm {
  readonly provider: AccountProvider;
  readonly label: string;
  readonly address: string;
  readonly username: string;
  readonly password: string;
  readonly imap: MailServerForm;
  readonly smtp: MailServerForm;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
  /** `yyyy-mm-dd`, or empty for no known expiry. */
  readonly tokenExpiresOn: string;
  readonly clientId: string;
  readonly tenant: string;
}

const SOCIAL_TOKEN_DAYS = 60;

const dateInputValue = (date: DateTime.DateTime) => DateTime.formatIso(date).slice(0, 10);

function accountProviderOf(account: CompanyChannelAccount): AccountProvider {
  switch (account.connection._tag) {
    case "imap":
      return account.connection.preset === "custom" ? "imap" : account.connection.preset;
    case "microsoft":
      return "microsoft";
    default:
      return account.connection._tag;
  }
}

export function emptyAccountForm(provider: AccountProvider, now: DateTime.Utc): AccountForm {
  return {
    provider,
    label: "",
    address: "",
    username: "",
    password: "",
    imap: { host: "", port: "993", security: "tls" },
    smtp: { host: "", port: "465", security: "tls" },
    consumerKey: "",
    consumerSecret: "",
    accessToken: "",
    accessTokenSecret: "",
    tokenExpiresOn:
      provider === "linkedin" || provider === "threads"
        ? dateInputValue(DateTime.add(now, { days: SOCIAL_TOKEN_DAYS }))
        : "",
    clientId: "",
    tenant: "",
  };
}

/** Secrets start blank: a blank secret keeps the saved one. */
export function accountFormFrom(account: CompanyChannelAccount, now: DateTime.Utc): AccountForm {
  const form = emptyAccountForm(accountProviderOf(account), now);
  const serverForm = (server: CompanyMailServer): MailServerForm => ({
    host: server.host,
    port: String(server.port),
    security: server.security,
  });
  const connection = account.connection;
  return {
    ...form,
    label: account.label,
    address: account.kind === "email" ? account.address : "",
    tokenExpiresOn: account.tokenExpiresAt === null ? "" : dateInputValue(account.tokenExpiresAt),
    ...(connection._tag === "imap"
      ? {
          username: connection.username === account.address ? "" : connection.username,
          imap: serverForm(connection.imap),
          smtp: serverForm(connection.smtp),
        }
      : {}),
    ...(connection._tag === "microsoft"
      ? {
          clientId: connection.clientId,
          tenant: connection.tenant === "common" ? "" : connection.tenant,
        }
      : {}),
  };
}

const secret = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : Redacted.make(trimmed);
};

const optionalSecrets = <K extends string>(values: Record<K, string>) => {
  const out: Partial<Record<K, Redacted.Redacted<string>>> = {};
  for (const key of Object.keys(values) as K[]) {
    const value = secret(values[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const parseServer = (server: MailServerForm): CompanyMailServer | null => {
  const host = server.host.trim();
  const port = Number(server.port.trim());
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, security: server.security };
};

const parseExpiry = (value: string): DateTime.Utc | null =>
  value.trim().length === 0 ? null : Option.getOrNull(DateTime.make(`${value.trim()}T00:00:00Z`));

/**
 * What saving the form sends, or the fields still missing. Editing allows
 * blank secrets, which the server keeps.
 */
export function buildAccountCredentials(
  form: AccountForm,
  editing: boolean,
):
  | { readonly credentials: CompanyChannelAccountCredentials }
  | { readonly missing: ReadonlyArray<string> } {
  const missing: Array<string> = [];
  const need = (value: string, what: string) => {
    if (!editing && value.trim().length === 0) missing.push(what);
  };
  const done = (credentials: CompanyChannelAccountCredentials) =>
    missing.length > 0 ? { missing } : { credentials };

  switch (form.provider) {
    case "microsoft":
      return done({ _tag: "microsoft" });
    case "x":
      need(form.consumerKey, "API key");
      need(form.consumerSecret, "API key secret");
      need(form.accessToken, "access token");
      need(form.accessTokenSecret, "access token secret");
      return done({
        _tag: "x",
        ...optionalSecrets({
          consumerKey: form.consumerKey,
          consumerSecret: form.consumerSecret,
          accessToken: form.accessToken,
          accessTokenSecret: form.accessTokenSecret,
        }),
      });
    case "linkedin":
    case "threads":
      need(form.accessToken, "access token");
      return done({
        _tag: form.provider,
        ...optionalSecrets({ accessToken: form.accessToken }),
        tokenExpiresAt: parseExpiry(form.tokenExpiresOn),
      });
    default: {
      const address = form.address.trim();
      if (address.length === 0) missing.push("email address");
      need(form.password, "app password");
      const username = form.username.trim();
      const custom = form.provider === "imap";
      const imap = custom ? parseServer(form.imap) : null;
      const smtp = custom ? parseServer(form.smtp) : null;
      if (custom && imap === null) missing.push("IMAP server and port");
      if (custom && smtp === null) missing.push("SMTP server and port");
      return done({
        _tag: "imap",
        preset: custom ? "custom" : (form.provider as Exclude<CompanyEmailPreset, "custom">),
        address,
        ...(username.length > 0 ? { username } : {}),
        ...optionalSecrets({ password: form.password }),
        ...(imap !== null && smtp !== null ? { imap, smtp } : {}),
      });
    }
  }
}
