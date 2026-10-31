import * as Schema from "effect/Schema";

import { PortSchema, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A company's channels: email accounts it reads and sends from, and social
 * accounts it publishes to. Agents only draft into `company/outbox`; the user
 * sends. Secrets stay on the server and never cross the wire after saving.
 */
export const CompanyChannelKind = Schema.Literals(["email", "x", "linkedin", "threads"]);
export type CompanyChannelKind = typeof CompanyChannelKind.Type;

export const CompanyChannelAccountId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).pipe(Schema.brand("CompanyChannelAccountId"));
export type CompanyChannelAccountId = typeof CompanyChannelAccountId.Type;

/** The draft's file name in `company/outbox`, without `.md`. */
export const CompanyDraftId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,127}$/),
).pipe(Schema.brand("CompanyDraftId"));
export type CompanyDraftId = typeof CompanyDraftId.Type;

export const CompanyEmailPreset = Schema.Literals(["gmail", "icloud", "fastmail", "custom"]);
export type CompanyEmailPreset = typeof CompanyEmailPreset.Type;

/** `tls` connects over TLS; `starttls` upgrades a plain connection. */
export const CompanyMailSecurity = Schema.Literals(["tls", "starttls"]);
export type CompanyMailSecurity = typeof CompanyMailSecurity.Type;

export const CompanyMailServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: PortSchema,
  security: CompanyMailSecurity,
});
export type CompanyMailServer = typeof CompanyMailServer.Type;

/** How an account connects, without its secrets. */
export const CompanyChannelConnection = Schema.Union([
  Schema.TaggedStruct("imap", {
    preset: CompanyEmailPreset,
    imap: CompanyMailServer,
    smtp: CompanyMailServer,
    username: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("microsoft", {
    tenant: TrimmedNonEmptyString,
    clientId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("x", {}),
  Schema.TaggedStruct("linkedin", { authorUrn: TrimmedNonEmptyString }),
  Schema.TaggedStruct("threads", { userId: TrimmedNonEmptyString }),
]);
export type CompanyChannelConnection = typeof CompanyChannelConnection.Type;

/** Worked out when accounts are listed, from the last use and the token's expiry. */
export const CompanyChannelHealth = Schema.Union([
  Schema.TaggedStruct("ok", {}),
  Schema.TaggedStruct("error", { message: Schema.String }),
  Schema.TaggedStruct("expiring", { expiresInDays: Schema.Int }),
  Schema.TaggedStruct("expired", {}),
]);
export type CompanyChannelHealth = typeof CompanyChannelHealth.Type;

export const CompanyChannelAccount = Schema.Struct({
  id: CompanyChannelAccountId,
  projectId: ProjectId,
  kind: CompanyChannelKind,
  label: TrimmedNonEmptyString,
  /** The email address, or the social handle or name. */
  address: Schema.String,
  connection: CompanyChannelConnection,
  createdAt: Schema.DateTimeUtc,
  tokenExpiresAt: Schema.NullOr(Schema.DateTimeUtc),
  health: CompanyChannelHealth,
});
export type CompanyChannelAccount = typeof CompanyChannelAccount.Type;

const Secret = Schema.RedactedFromValue(TrimmedNonEmptyString);

/**
 * What saving an account sends. Secrets are optional when updating: an
 * omitted one keeps the saved value. Microsoft accounts are added by signing in.
 */
export const CompanyChannelAccountCredentials = Schema.Union([
  Schema.TaggedStruct("imap", {
    preset: CompanyEmailPreset,
    address: TrimmedNonEmptyString,
    username: Schema.optionalKey(TrimmedNonEmptyString),
    password: Schema.optionalKey(Secret),
    /** Required for `custom`; presets use their provider's servers. */
    imap: Schema.optionalKey(CompanyMailServer),
    smtp: Schema.optionalKey(CompanyMailServer),
  }),
  Schema.TaggedStruct("x", {
    consumerKey: Schema.optionalKey(Secret),
    consumerSecret: Schema.optionalKey(Secret),
    accessToken: Schema.optionalKey(Secret),
    accessTokenSecret: Schema.optionalKey(Secret),
  }),
  Schema.TaggedStruct("linkedin", {
    accessToken: Schema.optionalKey(Secret),
    /** LinkedIn shows it when issuing the token; it is not readable later. */
    tokenExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc)),
  }),
  Schema.TaggedStruct("threads", {
    accessToken: Schema.optionalKey(Secret),
    tokenExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc)),
  }),
  /** Updates a signed-in Microsoft account's label; signing in again replaces its tokens. */
  Schema.TaggedStruct("microsoft", {}),
]);
export type CompanyChannelAccountCredentials = typeof CompanyChannelAccountCredentials.Type;

export const CompanyChannelsProjectInput = Schema.Struct({ projectId: ProjectId });
export type CompanyChannelsProjectInput = typeof CompanyChannelsProjectInput.Type;

export const CompanyChannelAccountList = Schema.Struct({
  accounts: Schema.Array(CompanyChannelAccount),
});
export type CompanyChannelAccountList = typeof CompanyChannelAccountList.Type;

export const CompanyChannelAccountSaveInput = Schema.Struct({
  projectId: ProjectId,
  /** Omitted to add an account. */
  accountId: Schema.optionalKey(CompanyChannelAccountId),
  label: TrimmedNonEmptyString,
  credentials: CompanyChannelAccountCredentials,
});
export type CompanyChannelAccountSaveInput = typeof CompanyChannelAccountSaveInput.Type;

export const CompanyChannelAccountRemoveInput = Schema.Struct({
  projectId: ProjectId,
  accountId: CompanyChannelAccountId,
});
export type CompanyChannelAccountRemoveInput = typeof CompanyChannelAccountRemoveInput.Type;

export const CompanyChannelAccountRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type CompanyChannelAccountRemoveResult = typeof CompanyChannelAccountRemoveResult.Type;

/** Signs in to Outlook or Microsoft 365 with the user's own Azure app (a public client). */
export const CompanyMicrosoftSignInStartInput = Schema.Struct({
  projectId: ProjectId,
  /** Signs this account in again instead of adding one. */
  accountId: Schema.optionalKey(CompanyChannelAccountId),
  label: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  /** Defaults to `common`. */
  tenant: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CompanyMicrosoftSignInStartInput = typeof CompanyMicrosoftSignInStartInput.Type;

export const CompanyMicrosoftSignInPrompt = Schema.Struct({
  userCode: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type CompanyMicrosoftSignInPrompt = typeof CompanyMicrosoftSignInPrompt.Type;

export const CompanyInboxListInput = Schema.Struct({
  projectId: ProjectId,
  accountId: CompanyChannelAccountId,
  /** At most 50; defaults to 50. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type CompanyInboxListInput = typeof CompanyInboxListInput.Type;

export const CompanyInboxMessageSummary = Schema.Struct({
  /** The IMAP UID or the Microsoft Graph message id. */
  id: TrimmedNonEmptyString,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  date: Schema.NullOr(Schema.DateTimeUtc),
  snippet: Schema.String,
  unread: Schema.Boolean,
});
export type CompanyInboxMessageSummary = typeof CompanyInboxMessageSummary.Type;

export const CompanyInboxList = Schema.Struct({
  accountId: CompanyChannelAccountId,
  messages: Schema.Array(CompanyInboxMessageSummary),
});
export type CompanyInboxList = typeof CompanyInboxList.Type;

export const CompanyMessageReadInput = Schema.Struct({
  projectId: ProjectId,
  accountId: CompanyChannelAccountId,
  messageId: TrimmedNonEmptyString,
});
export type CompanyMessageReadInput = typeof CompanyMessageReadInput.Type;

export const CompanyInboxMessage = Schema.Struct({
  ...CompanyInboxMessageSummary.fields,
  cc: Schema.Array(Schema.String),
  /** Plain text: the text part, or text recovered from the HTML part. */
  text: Schema.String,
  /** The Message-ID header, for replies. */
  messageIdHeader: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
});
export type CompanyInboxMessage = typeof CompanyInboxMessage.Type;

export const CompanyDraftStatus = Schema.Literals(["draft", "sent", "failed"]);
export type CompanyDraftStatus = typeof CompanyDraftStatus.Type;

/** A file in `company/outbox`: frontmatter fields plus the markdown body. */
export const CompanyDraft = Schema.Struct({
  id: CompanyDraftId,
  /** Relative to the project folder. */
  path: TrimmedNonEmptyString,
  channel: CompanyChannelKind,
  account: CompanyChannelAccountId,
  status: CompanyDraftStatus,
  createdBy: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
  to: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  cc: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  subject: Schema.optionalKey(Schema.String),
  /** The Message-ID this email answers. */
  inReplyTo: Schema.optionalKey(TrimmedNonEmptyString),
  references: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** The inbox message id this answers, which Microsoft Graph replies through. */
  replyToMessageId: Schema.optionalKey(TrimmedNonEmptyString),
  sentAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** Where a published post lives. */
  url: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  body: Schema.String,
});
export type CompanyDraft = typeof CompanyDraft.Type;

export const CompanyMalformedDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  message: Schema.String,
});
export type CompanyMalformedDraft = typeof CompanyMalformedDraft.Type;

export const CompanyOutbox = Schema.Struct({
  /** Newest first. */
  drafts: Schema.Array(CompanyDraft),
  /** Files in `company/outbox` that could not be read as drafts. */
  malformed: Schema.Array(CompanyMalformedDraft),
});
export type CompanyOutbox = typeof CompanyOutbox.Type;

export const CompanyDraftContent = Schema.Struct({
  channel: CompanyChannelKind,
  accountId: CompanyChannelAccountId,
  text: Schema.String,
  to: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  cc: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  subject: Schema.optionalKey(Schema.String),
  /**
   * An inbox message id: the draft replies to it, threaded and addressed like
   * a reply. An update that omits it keeps the draft's.
   */
  replyToMessageId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CompanyDraftContent = typeof CompanyDraftContent.Type;

export const CompanyDraftSaveInput = Schema.Struct({
  projectId: ProjectId,
  /** Omitted to create a draft. */
  draftId: Schema.optionalKey(CompanyDraftId),
  draft: CompanyDraftContent,
});
export type CompanyDraftSaveInput = typeof CompanyDraftSaveInput.Type;

export const CompanyDraftInput = Schema.Struct({
  projectId: ProjectId,
  draftId: CompanyDraftId,
});
export type CompanyDraftInput = typeof CompanyDraftInput.Type;

export const CompanyDraftDiscardResult = Schema.Struct({ discarded: Schema.Boolean });
export type CompanyDraftDiscardResult = typeof CompanyDraftDiscardResult.Type;

const COMPANY_CHANNEL_FAILURES = [
  "unknown_project",
  "unknown_account",
  "unknown_draft",
  "unknown_message",
  "invalid_input",
  "auth_failed",
  "unreachable",
  "provider_error",
  "storage",
  "too_long",
  "not_sendable",
  "busy",
  "sign_in_not_started",
  "sign_in_expired",
  "sign_in_denied",
  "sign_in_cancelled",
] as const;

export const CompanyChannelFailure = Schema.Literals(COMPANY_CHANNEL_FAILURES);
export type CompanyChannelFailure = typeof CompanyChannelFailure.Type;

/** Why a channel call failed, in words a user can act on. The server logs causes; they hold credentials. */
export class CompanyChannelError extends Schema.TaggedError<CompanyChannelError>()(
  "CompanyChannelError",
  {
    reason: CompanyChannelFailure,
    message: Schema.String,
  },
) {}
