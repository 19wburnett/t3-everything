import {
  type CompanyChannelAccount,
  CompanyChannelAccountId,
  type CompanyChannelAccountSaveInput,
  CompanyChannelConnection,
  CompanyChannelError,
  type CompanyChannelFailure,
  type CompanyChannelHealth,
  CompanyChannelKind,
  type CompanyDraft,
  type CompanyDraftId,
  type CompanyDraftInput,
  type CompanyDraftSaveInput,
  type CompanyEmailPreset,
  type CompanyInboxList,
  type CompanyInboxListInput,
  type CompanyInboxMessage,
  type CompanyInboxMessageSummary,
  type CompanyMailServer,
  type CompanyMalformedDraft,
  type CompanyMessageReadInput,
  type CompanyMicrosoftSignInPrompt,
  type CompanyMicrosoftSignInStartInput,
  type CompanyOutbox,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Apis from "./channelApis.ts";
import * as MailTransport from "./MailTransport.ts";
import { signOAuth1 } from "./oauth1.ts";
import {
  draftIdFromFileName,
  draftPath,
  newDraftId,
  OUTBOX_DIR,
  parseDraft,
  serializeDraft,
} from "./outboxFile.ts";

const ACCOUNTS_FILE = "company-channels.json";
const DEFAULT_INBOX_LIMIT = 50;
const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = Duration.toMillis(Duration.days(1));
// Threads tokens refresh on use once a week, well inside their 60 days.
const THREADS_REFRESH_AFTER_MS = 7 * DAY_MS;
// Refresh ahead of expiry so a token never lapses mid-request.
const MICROSOFT_REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(5));

const POST_LIMITS: Partial<Record<CompanyChannelKind, number>> = {
  x: 280,
  threads: 500,
  linkedin: 3000,
};

const MAIL_PRESETS: Record<
  Exclude<CompanyEmailPreset, "custom">,
  { readonly imap: CompanyMailServer; readonly smtp: CompanyMailServer }
> = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
  },
  fastmail: {
    imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
  },
};

const AccountRecord = Schema.Struct({
  id: CompanyChannelAccountId,
  projectId: ProjectId,
  kind: CompanyChannelKind,
  label: Schema.String,
  address: Schema.String,
  connection: CompanyChannelConnection,
  createdAt: Schema.DateTimeUtc,
  tokenExpiresAt: Schema.NullOr(Schema.DateTimeUtc),
  tokenRefreshedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
type AccountRecord = typeof AccountRecord.Type;

const AccountsFile = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({ version: Schema.Literal(1), accounts: Schema.Array(AccountRecord) }),
  ),
);
const decodeAccountsFile = Schema.decodeUnknownEffect(AccountsFile);
const encodeAccountsFile = Schema.encodeSync(AccountsFile);

const AccountSecret = Schema.Union([
  Schema.TaggedStruct("imap", { password: Schema.String }),
  Schema.TaggedStruct("microsoft", {
    refreshToken: Schema.String,
    accessToken: Schema.NullOr(Schema.String),
    accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  }),
  Schema.TaggedStruct("x", {
    consumerKey: Schema.String,
    consumerSecret: Schema.String,
    accessToken: Schema.String,
    accessTokenSecret: Schema.String,
  }),
  Schema.TaggedStruct("linkedin", { accessToken: Schema.String }),
  Schema.TaggedStruct("threads", { accessToken: Schema.String }),
]);
type AccountSecret = typeof AccountSecret.Type;
const AccountSecretJson = Schema.fromJsonString(AccountSecret);
const decodeSecret = Schema.decodeUnknownOption(AccountSecretJson);
const encodeSecret = Schema.encodeSync(AccountSecretJson);

const secretName = (id: CompanyChannelAccountId) => `company-channel-${id}`;

const channelError = (reason: CompanyChannelFailure, message: string) =>
  new CompanyChannelError({ reason, message });

const fromApiError = (error: Apis.ChannelApiError) =>
  channelError(
    error.reason === "auth"
      ? "auth_failed"
      : error.reason === "unreachable"
        ? "unreachable"
        : "provider_error",
    error.message,
  );

const fromMailError = (error: MailTransport.MailTransportError) =>
  channelError(
    error.reason === "auth"
      ? "auth_failed"
      : error.reason === "unreachable"
        ? "unreachable"
        : "provider_error",
    error.message,
  );

/** Logs the cause, which may hold credentials or payloads, and fails with a fixed message. */
const storageFailure =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, CompanyChannelError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.andThen(Effect.fail(channelError("storage", message))),
    );

const reveal = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

const accountHealth = (record: AccountRecord, now: DateTime.Utc): CompanyChannelHealth => {
  if (record.lastError !== null) return { _tag: "error", message: record.lastError };
  if (record.tokenExpiresAt === null) return { _tag: "ok" };
  if (DateTime.isLessThanOrEqualTo(record.tokenExpiresAt, now)) return { _tag: "expired" };
  const days = Math.ceil(Duration.toDays(DateTime.distance(now, record.tokenExpiresAt)));
  return days <= EXPIRY_WARNING_DAYS ? { _tag: "expiring", expiresInDays: days } : { _tag: "ok" };
};

const toAccount = (record: AccountRecord, now: DateTime.Utc): CompanyChannelAccount => ({
  id: record.id,
  projectId: record.projectId,
  kind: record.kind,
  label: record.label,
  address: record.address,
  connection: record.connection,
  createdAt: record.createdAt,
  tokenExpiresAt: record.tokenExpiresAt,
  health: accountHealth(record, now),
});

const codePoints = (text: string) => Array.from(text).length;

const replySubject = (subject: string) =>
  /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`.trim();

const bareAddress = (formatted: string) => /<([^>]+)>/.exec(formatted)?.[1] ?? formatted.trim();

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<CompanyChannelAccount, CompanyChannelError>;
  readonly fiber: Fiber.Fiber<unknown>;
}

export interface CompanyDraftRequest extends CompanyDraftSaveInput {
  /** Who wrote it, such as "Muse" or "Claude". Kept on updates; new drafts default to "You". */
  readonly createdBy?: string | undefined;
}

export class CompanyChannels extends Context.Service<
  CompanyChannels,
  {
    readonly listAccounts: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<CompanyChannelAccount>, CompanyChannelError>;
    /** Signs in with the credentials before saving, so a saved account works. */
    readonly saveAccount: (
      input: CompanyChannelAccountSaveInput,
    ) => Effect.Effect<CompanyChannelAccount, CompanyChannelError>;
    readonly removeAccount: (input: {
      readonly projectId: ProjectId;
      readonly accountId: CompanyChannelAccountId;
    }) => Effect.Effect<boolean, CompanyChannelError>;
    readonly microsoftSignInStart: (
      input: CompanyMicrosoftSignInStartInput,
    ) => Effect.Effect<CompanyMicrosoftSignInPrompt, CompanyChannelError>;
    readonly microsoftSignInWait: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyChannelAccount, CompanyChannelError>;
    readonly microsoftSignInCancel: (projectId: ProjectId) => Effect.Effect<void>;
    readonly listInbox: (
      input: CompanyInboxListInput,
    ) => Effect.Effect<CompanyInboxList, CompanyChannelError>;
    readonly readMessage: (
      input: CompanyMessageReadInput,
    ) => Effect.Effect<CompanyInboxMessage, CompanyChannelError>;
    /** Malformed files are listed, not thrown. */
    readonly listOutbox: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyOutbox, CompanyChannelError>;
    readonly saveDraft: (
      input: CompanyDraftRequest,
    ) => Effect.Effect<CompanyDraft, CompanyChannelError>;
    readonly discardDraft: (
      input: CompanyDraftInput,
    ) => Effect.Effect<boolean, CompanyChannelError>;
    /**
     * Sends a draft or failed draft once. A provider refusing it is recorded
     * in the file as `failed` and returned, not failed with.
     */
    readonly send: (input: CompanyDraftInput) => Effect.Effect<CompanyDraft, CompanyChannelError>;
  }
>()("t3/companyChannels/CompanyChannels") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const mail = yield* MailTransport.MailTransport;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const scope = yield* Effect.scope;

  const accountsPath = path.join(config.stateDir, ACCOUNTS_FILE);
  const accountsLock = yield* Semaphore.make(1);
  const tokenLock = yield* Semaphore.make(1);
  const busyDrafts = yield* Ref.make<ReadonlySet<string>>(new Set());
  // A send whose result could not be written must not go out again from this process.
  const sentUnrecorded = yield* Ref.make<ReadonlySet<string>>(new Set());
  const pendingSignIns = yield* Ref.make<ReadonlyMap<ProjectId, PendingSignIn>>(new Map());

  const randomHex = Effect.fn("CompanyChannels.randomHex")(function* (bytes: number) {
    return Hex.encode(yield* crypto.randomBytes(bytes).pipe(Effect.orDie));
  });

  const readRecords = Effect.fn("CompanyChannels.readRecords")(function* () {
    const text = yield* fileSystem.readFileString(accountsPath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      Effect.catch(storageFailure("Could not read the company channel accounts.")),
    );
    if (Option.isNone(text)) return [] as ReadonlyArray<AccountRecord>;
    const file = yield* decodeAccountsFile(text.value).pipe(
      Effect.catch(storageFailure("The company channel accounts file is unreadable.")),
    );
    return file.accounts;
  });

  const writeRecords = Effect.fn("CompanyChannels.writeRecords")(function* (
    accounts: ReadonlyArray<AccountRecord>,
  ) {
    const tempPath = `${accountsPath}.${yield* randomHex(8)}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFileString(tempPath, encodeAccountsFile({ version: 1, accounts }), {
        mode: 0o600,
      });
      yield* fileSystem.rename(tempPath, accountsPath);
    }).pipe(
      Effect.catch((cause) =>
        fileSystem
          .remove(tempPath)
          .pipe(
            Effect.ignore,
            Effect.andThen(storageFailure("Could not save the company channel accounts.")(cause)),
          ),
      ),
    );
  });

  /** Read-modify-write of the records file, one at a time. */
  const updateRecords = <A>(
    update: (accounts: ReadonlyArray<AccountRecord>) => {
      readonly accounts: ReadonlyArray<AccountRecord>;
      readonly result: A;
    },
  ) =>
    accountsLock.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* readRecords());
        yield* writeRecords(next.accounts);
        return next.result;
      }),
    );

  const patchRecord = (id: CompanyChannelAccountId, patch: Partial<AccountRecord>) =>
    updateRecords((accounts) => ({
      accounts: accounts.map((record) => (record.id === id ? { ...record, ...patch } : record)),
      result: undefined,
    }));

  const findRecord = Effect.fn("CompanyChannels.findRecord")(function* (
    projectId: ProjectId,
    accountId: CompanyChannelAccountId,
  ) {
    const record = (yield* readRecords()).find(
      (candidate) => candidate.id === accountId && candidate.projectId === projectId,
    );
    if (record === undefined) {
      return yield* channelError(
        "unknown_account",
        "That account is not connected to this company.",
      );
    }
    return record;
  });

  const readSecret = Effect.fn("CompanyChannels.readSecret")(function* (record: AccountRecord) {
    const bytes = yield* secrets
      .get(secretName(record.id))
      .pipe(Effect.catch(storageFailure("Could not read the account's credentials.")));
    const secret = Option.flatMap(bytes, (value) => decodeSecret(new TextDecoder().decode(value)));
    if (Option.isNone(secret)) {
      return yield* channelError(
        "auth_failed",
        "This account's saved credentials are missing. Connect it again.",
      );
    }
    return secret.value;
  });

  const writeSecret = (id: CompanyChannelAccountId, secret: AccountSecret) =>
    secrets
      .set(secretName(id), new TextEncoder().encode(encodeSecret(secret)))
      .pipe(Effect.catch(storageFailure("Could not save the account's credentials.")));

  /** Records an auth refusal as the account's health, and clears it on success. */
  // Health is advisory: failing to record it must not fail what it describes, such as a send.
  const tracked = <A>(record: AccountRecord, effect: Effect.Effect<A, CompanyChannelError>) =>
    effect.pipe(
      Effect.tap(() =>
        record.lastError === null
          ? Effect.void
          : patchRecord(record.id, { lastError: null }).pipe(Effect.ignore),
      ),
      Effect.tapError((error) =>
        error.reason === "auth_failed"
          ? patchRecord(record.id, { lastError: error.message }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  const requireProject = Effect.fn("CompanyChannels.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const shell = yield* projects
      .getShell(projectId)
      .pipe(Effect.catch(storageFailure("Could not read the project.")));
    if (Option.isNone(shell)) {
      return yield* channelError("unknown_project", "That project does not exist.");
    }
    return shell.value;
  });

  const xSigner = (secret: Extract<AccountSecret, { _tag: "x" }>): Apis.XSigner =>
    Effect.fn("CompanyChannels.signX")(function* (method, url) {
      const timestampSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      return signOAuth1(secret, { method, url, nonce: yield* randomHex(16), timestampSeconds })
        .header;
    });

  const imapLogin = (
    connection: Extract<CompanyChannelConnection, { _tag: "imap" }>,
    secret: AccountSecret,
  ) =>
    secret._tag === "imap"
      ? Effect.succeed({
          imap: connection.imap,
          smtp: connection.smtp,
          username: connection.username,
          password: secret.password,
        } satisfies MailTransport.MailLogin)
      : Effect.fail(
          channelError("auth_failed", "This account's saved credentials do not match it."),
        );

  const microsoftAccessToken = Effect.fn("CompanyChannels.microsoftAccessToken")(function* (
    record: AccountRecord,
  ) {
    const connection = record.connection;
    if (connection._tag !== "microsoft") {
      return yield* channelError("invalid_input", "This is not a Microsoft account.");
    }
    return yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const secret = yield* readSecret(record);
        if (secret._tag !== "microsoft") {
          return yield* channelError(
            "auth_failed",
            "This account's saved credentials do not match it.",
          );
        }
        const now = yield* Clock.currentTimeMillis;
        if (
          secret.accessToken !== null &&
          secret.accessTokenExpiresAt !== null &&
          now < secret.accessTokenExpiresAt - MICROSOFT_REFRESH_MARGIN_MS
        ) {
          return secret.accessToken;
        }
        const tokens = yield* Apis.microsoftRefresh(
          http,
          connection.tenant,
          connection.clientId,
          secret.refreshToken,
        ).pipe(Effect.mapError(fromApiError));
        yield* writeSecret(record.id, {
          _tag: "microsoft",
          refreshToken: tokens.refreshToken ?? secret.refreshToken,
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: now + tokens.expiresInSeconds * 1000,
        });
        return tokens.accessToken;
      }),
    );
  });

  /** Threads tokens last 60 days and refresh only while valid, so refresh them as they are used. */
  const threadsAccessToken = Effect.fn("CompanyChannels.threadsAccessToken")(function* (
    record: AccountRecord,
  ) {
    return yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const current =
          (yield* readRecords()).find((candidate) => candidate.id === record.id) ?? record;
        const secret = yield* readSecret(current);
        if (secret._tag !== "threads") {
          return yield* channelError(
            "auth_failed",
            "This account's saved credentials do not match it.",
          );
        }
        const now = yield* DateTime.now;
        const refreshedAt = current.tokenRefreshedAt ?? current.createdAt;
        if (
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(refreshedAt) <
          THREADS_REFRESH_AFTER_MS
        ) {
          return secret.accessToken;
        }
        const refreshed = yield* Apis.threadsRefresh(http, secret.accessToken).pipe(Effect.option);
        if (Option.isNone(refreshed)) {
          yield* Effect.logWarning("Could not refresh the Threads token; using the saved one.");
          return secret.accessToken;
        }
        yield* writeSecret(current.id, {
          _tag: "threads",
          accessToken: refreshed.value.access_token,
        });
        yield* patchRecord(current.id, {
          tokenRefreshedAt: now,
          tokenExpiresAt: DateTime.add(now, { seconds: refreshed.value.expires_in }),
        });
        return refreshed.value.access_token;
      }),
    );
  });

  const listAccounts: CompanyChannels["Service"]["listAccounts"] = Effect.fn(
    "CompanyChannels.listAccounts",
  )(function* (projectId) {
    const now = yield* DateTime.now;
    return (yield* readRecords())
      .filter((record) => record.projectId === projectId)
      .map((record) => toAccount(record, now));
  });

  /** Signs in with merged credentials and says what the account is. */
  const validate = Effect.fn("CompanyChannels.validate")(function* (
    input: CompanyChannelAccountSaveInput,
    existing: { readonly record: AccountRecord; readonly secret: AccountSecret } | undefined,
  ) {
    const credentials = input.credentials;
    const missing = (what: string) =>
      Effect.fail(channelError("invalid_input", `Enter the ${what} to connect this account.`));
    const previous = existing?.secret;
    switch (credentials._tag) {
      case "imap": {
        const servers =
          credentials.preset === "custom"
            ? credentials.imap !== undefined && credentials.smtp !== undefined
              ? { imap: credentials.imap, smtp: credentials.smtp }
              : existing?.record.connection._tag === "imap"
                ? existing.record.connection
                : undefined
            : MAIL_PRESETS[credentials.preset];
        if (servers === undefined) return yield* missing("IMAP and SMTP servers");
        const password =
          reveal(credentials.password) ??
          (previous?._tag === "imap" ? previous.password : undefined);
        if (password === undefined) return yield* missing("app password");
        const connection = {
          _tag: "imap",
          preset: credentials.preset,
          imap: servers.imap,
          smtp: servers.smtp,
          username: credentials.username ?? credentials.address,
        } as const;
        yield* mail
          .verify({
            imap: connection.imap,
            smtp: connection.smtp,
            username: connection.username,
            password,
          })
          .pipe(Effect.mapError(fromMailError));
        return {
          kind: "email",
          address: credentials.address,
          connection,
          secret: { _tag: "imap", password },
          tokenExpiresAt: null,
        } as const;
      }
      case "x": {
        const old = previous?._tag === "x" ? previous : undefined;
        const secret = {
          _tag: "x",
          consumerKey: reveal(credentials.consumerKey) ?? old?.consumerKey,
          consumerSecret: reveal(credentials.consumerSecret) ?? old?.consumerSecret,
          accessToken: reveal(credentials.accessToken) ?? old?.accessToken,
          accessTokenSecret: reveal(credentials.accessTokenSecret) ?? old?.accessTokenSecret,
        } as const;
        const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = secret;
        if (
          consumerKey === undefined ||
          consumerSecret === undefined ||
          accessToken === undefined ||
          accessTokenSecret === undefined
        ) {
          return yield* missing("API key, API key secret, access token, and access token secret");
        }
        const complete = {
          _tag: "x",
          consumerKey,
          consumerSecret,
          accessToken,
          accessTokenSecret,
        } as const;
        const me = yield* Apis.xMe(http, xSigner(complete)).pipe(Effect.mapError(fromApiError));
        return {
          kind: "x",
          address: `@${me.username}`,
          connection: { _tag: "x" },
          secret: complete,
          tokenExpiresAt: null,
        } as const;
      }
      case "linkedin": {
        const accessToken =
          reveal(credentials.accessToken) ??
          (previous?._tag === "linkedin" ? previous.accessToken : undefined);
        if (accessToken === undefined) return yield* missing("access token");
        const member = yield* Apis.linkedInUserInfo(http, accessToken).pipe(
          Effect.mapError(fromApiError),
        );
        return {
          kind: "linkedin",
          address: member.name ?? member.sub,
          connection: { _tag: "linkedin", authorUrn: `urn:li:person:${member.sub}` },
          secret: { _tag: "linkedin", accessToken },
          tokenExpiresAt:
            credentials.tokenExpiresAt === undefined
              ? (existing?.record.tokenExpiresAt ?? null)
              : credentials.tokenExpiresAt,
        } as const;
      }
      case "threads": {
        const accessToken =
          reveal(credentials.accessToken) ??
          (previous?._tag === "threads" ? previous.accessToken : undefined);
        if (accessToken === undefined) return yield* missing("access token");
        const me = yield* Apis.threadsMe(http, accessToken).pipe(Effect.mapError(fromApiError));
        return {
          kind: "threads",
          address: me.username === undefined ? me.id : `@${me.username}`,
          connection: { _tag: "threads", userId: me.id },
          secret: { _tag: "threads", accessToken },
          tokenExpiresAt:
            credentials.tokenExpiresAt === undefined
              ? (existing?.record.tokenExpiresAt ?? null)
              : credentials.tokenExpiresAt,
        } as const;
      }
      case "microsoft": {
        if (existing === undefined || existing.record.connection._tag !== "microsoft") {
          return yield* channelError(
            "invalid_input",
            "Add an Outlook or Microsoft 365 account by signing in with Microsoft.",
          );
        }
        return {
          kind: "email",
          address: existing.record.address,
          connection: existing.record.connection,
          secret: existing.secret,
          tokenExpiresAt: null,
        } as const;
      }
    }
  });

  const saveAccount: CompanyChannels["Service"]["saveAccount"] = Effect.fn(
    "CompanyChannels.saveAccount",
  )(function* (input) {
    yield* requireProject(input.projectId);
    const existing =
      input.accountId === undefined
        ? undefined
        : yield* findRecord(input.projectId, input.accountId).pipe(
            Effect.flatMap((record) =>
              readSecret(record).pipe(
                Effect.map((secret) => ({ record, secret })),
                // A lost secret is replaced by the one being saved.
                Effect.catchTags({
                  CompanyChannelError: (error) =>
                    error.reason === "auth_failed"
                      ? Effect.succeed({ record, secret: undefined })
                      : Effect.fail(error),
                }),
              ),
            ),
          );
    if (existing !== undefined && existing.record.connection._tag !== input.credentials._tag) {
      return yield* channelError("invalid_input", "An account cannot change what kind it is.");
    }
    const validated = yield* validate(
      input,
      existing?.secret === undefined
        ? undefined
        : { record: existing.record, secret: existing.secret },
    );
    const now = yield* DateTime.now;
    const id = existing?.record.id ?? CompanyChannelAccountId.make(`acct-${yield* randomHex(6)}`);
    const record: AccountRecord = {
      id,
      projectId: input.projectId,
      kind: validated.kind,
      label: input.label,
      address: validated.address,
      connection: validated.connection,
      createdAt: existing?.record.createdAt ?? now,
      tokenExpiresAt: validated.tokenExpiresAt,
      tokenRefreshedAt:
        input.credentials._tag === "threads" && input.credentials.accessToken !== undefined
          ? now
          : (existing?.record.tokenRefreshedAt ?? null),
      lastError: null,
    };
    yield* writeSecret(id, validated.secret);
    yield* updateRecords((accounts) => ({
      accounts: accounts.some((candidate) => candidate.id === id)
        ? accounts.map((candidate) => (candidate.id === id ? record : candidate))
        : [...accounts, record],
      result: undefined,
    }));
    return toAccount(record, now);
  });

  const removeAccount: CompanyChannels["Service"]["removeAccount"] = Effect.fn(
    "CompanyChannels.removeAccount",
  )(function* ({ projectId, accountId }) {
    const removed = yield* updateRecords((accounts) => {
      const kept = accounts.filter(
        (record) => !(record.id === accountId && record.projectId === projectId),
      );
      return { accounts: kept, result: kept.length !== accounts.length };
    });
    if (removed) {
      yield* secrets
        .remove(secretName(accountId))
        .pipe(Effect.catch(storageFailure("Could not delete the account's credentials.")));
    }
    return removed;
  });

  const signInFailed = (reason: CompanyChannelFailure, message: string) =>
    channelError(reason, message);

  const finishMicrosoftSignIn = Effect.fn("CompanyChannels.finishMicrosoftSignIn")(function* (
    input: CompanyMicrosoftSignInStartInput,
    tenant: string,
    tokens: Apis.MicrosoftTokens,
  ) {
    if (tokens.refreshToken === null) {
      return yield* signInFailed(
        "provider_error",
        "Microsoft did not grant offline access. Allow the offline_access permission for the app.",
      );
    }
    const address = yield* Apis.graphMe(http, tokens.accessToken).pipe(
      Effect.mapError(fromApiError),
    );
    const now = yield* DateTime.now;
    const existing =
      input.accountId === undefined
        ? undefined
        : yield* findRecord(input.projectId, input.accountId);
    const id = existing?.id ?? CompanyChannelAccountId.make(`acct-${yield* randomHex(6)}`);
    const record: AccountRecord = {
      id,
      projectId: input.projectId,
      kind: "email",
      label: input.label,
      address,
      connection: { _tag: "microsoft", tenant, clientId: input.clientId },
      createdAt: existing?.createdAt ?? now,
      tokenExpiresAt: null,
      tokenRefreshedAt: now,
      lastError: null,
    };
    yield* writeSecret(id, {
      _tag: "microsoft",
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: DateTime.toEpochMillis(now) + tokens.expiresInSeconds * 1000,
    });
    yield* updateRecords((accounts) => ({
      accounts: accounts.some((candidate) => candidate.id === id)
        ? accounts.map((candidate) => (candidate.id === id ? record : candidate))
        : [...accounts, record],
      result: undefined,
    }));
    return toAccount(record, now);
  });

  const pollMicrosoft = Effect.fn("CompanyChannels.pollMicrosoft")(function* (
    input: CompanyMicrosoftSignInStartInput,
    tenant: string,
    deviceCode: string,
    expiresAtMs: number,
    initialIntervalSeconds: number,
  ) {
    let interval = initialIntervalSeconds;
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      if ((yield* Clock.currentTimeMillis) >= expiresAtMs) {
        return yield* signInFailed("sign_in_expired", "The sign-in code expired. Start again.");
      }
      // A dropped poll is retried on the next tick; the code stays valid until it expires.
      const answer = yield* Apis.microsoftPollToken(http, tenant, input.clientId, deviceCode).pipe(
        Effect.option,
      );
      if (Option.isNone(answer)) continue;
      switch (answer.value._tag) {
        case "Pending":
          continue;
        case "SlowDown":
          interval += 5;
          continue;
        case "Tokens":
          return yield* finishMicrosoftSignIn(input, tenant, answer.value.tokens);
        case "Refused":
          return yield* answer.value.error === "authorization_declined"
            ? signInFailed("sign_in_denied", "The sign-in was declined at Microsoft.")
            : answer.value.error === "expired_token" || answer.value.error === "code_expired"
              ? signInFailed("sign_in_expired", "The sign-in code expired. Start again.")
              : signInFailed(
                  "provider_error",
                  `Microsoft refused the sign-in (${answer.value.error}). Check the app's client id and that it allows public client flows.`,
                );
      }
    }
  });

  const microsoftSignInStart: CompanyChannels["Service"]["microsoftSignInStart"] = Effect.fn(
    "CompanyChannels.microsoftSignInStart",
  )(function* (input) {
    yield* requireProject(input.projectId);
    if (input.accountId !== undefined) {
      const record = yield* findRecord(input.projectId, input.accountId);
      if (record.connection._tag !== "microsoft") {
        return yield* channelError(
          "invalid_input",
          "That account does not sign in with Microsoft.",
        );
      }
    }
    const tenant = input.tenant ?? "common";
    const code = yield* Apis.microsoftDeviceCode(http, tenant, input.clientId).pipe(
      Effect.mapError(fromApiError),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const expiresAtMs = startedAt + code.expires_in * 1000;
    const deferred = yield* Deferred.make<CompanyChannelAccount, CompanyChannelError>();
    const fiber = yield* pollMicrosoft(
      input,
      tenant,
      code.device_code,
      expiresAtMs,
      code.interval ?? 5,
    ).pipe(Deferred.into(deferred), Effect.forkIn(scope));
    const previous = yield* Ref.modify(pendingSignIns, (current) => [
      current.get(input.projectId),
      new Map(current).set(input.projectId, { deferred, fiber }),
    ]);
    if (previous !== undefined) {
      yield* Deferred.fail(
        previous.deferred,
        signInFailed("sign_in_cancelled", "A newer sign-in replaced this one."),
      );
      yield* Fiber.interrupt(previous.fiber);
    }
    return {
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: DateTime.makeUnsafe(expiresAtMs),
    };
  });

  const microsoftSignInWait: CompanyChannels["Service"]["microsoftSignInWait"] = Effect.fn(
    "CompanyChannels.microsoftSignInWait",
  )(function* (projectId) {
    const current = (yield* Ref.get(pendingSignIns)).get(projectId);
    if (current === undefined) {
      return yield* signInFailed("sign_in_not_started", "No sign-in is in progress. Start again.");
    }
    return yield* Deferred.await(current.deferred);
  });

  const microsoftSignInCancel: CompanyChannels["Service"]["microsoftSignInCancel"] = Effect.fn(
    "CompanyChannels.microsoftSignInCancel",
  )(function* (projectId) {
    const current = (yield* Ref.get(pendingSignIns)).get(projectId);
    if (current === undefined) return;
    yield* Deferred.fail(
      current.deferred,
      signInFailed("sign_in_cancelled", "The sign-in was cancelled."),
    );
    yield* Fiber.interrupt(current.fiber);
  });

  const emailRecord = Effect.fn("CompanyChannels.emailRecord")(function* (
    projectId: ProjectId,
    accountId: CompanyChannelAccountId,
  ) {
    const record = yield* findRecord(projectId, accountId);
    if (record.kind !== "email") {
      return yield* channelError("invalid_input", "That account is not an email account.");
    }
    return record;
  });

  const toDate = (value: Date | string | null | undefined) =>
    value === null || value === undefined
      ? null
      : Option.getOrNull(Option.map(DateTime.make(value), DateTime.toUtc));

  const listInbox: CompanyChannels["Service"]["listInbox"] = Effect.fn("CompanyChannels.listInbox")(
    function* (input) {
      const record = yield* emailRecord(input.projectId, input.accountId);
      const limit = input.limit ?? DEFAULT_INBOX_LIMIT;
      const connection = record.connection;
      const messages = yield* tracked(
        record,
        Effect.gen(function* () {
          if (connection._tag === "imap") {
            const login = yield* imapLogin(connection, yield* readSecret(record));
            const summaries = yield* mail
              .listInbox(login, limit)
              .pipe(Effect.mapError(fromMailError));
            return summaries.map((summary): CompanyInboxMessageSummary => ({
              id: summary.uid,
              from: summary.from,
              to: summary.to,
              subject: summary.subject,
              date: toDate(summary.date),
              snippet: summary.snippet,
              unread: summary.unread,
            }));
          }
          const token = yield* microsoftAccessToken(record);
          const summaries = yield* Apis.graphListInbox(http, token, limit).pipe(
            Effect.mapError(fromApiError),
          );
          return summaries.map((summary): CompanyInboxMessageSummary => ({
            id: summary.id,
            from: Apis.formatGraphRecipient(summary.from ?? undefined),
            to: (summary.toRecipients ?? []).map(Apis.formatGraphRecipient),
            subject: summary.subject ?? "",
            date: toDate(summary.receivedDateTime),
            snippet: (summary.bodyPreview ?? "").slice(0, 200),
            unread: summary.isRead === false,
          }));
        }),
      );
      return { accountId: record.id, messages };
    },
  );

  const unknownMessage = () =>
    channelError("unknown_message", "That message is not in the inbox anymore.");

  const readMessageFrom = Effect.fn("CompanyChannels.readMessageFrom")(function* (
    record: AccountRecord,
    messageId: string,
  ) {
    const connection = record.connection;
    return yield* tracked(
      record,
      Effect.gen(function* () {
        if (connection._tag === "imap") {
          if (!/^\d+$/.test(messageId)) return yield* unknownMessage();
          const login = yield* imapLogin(connection, yield* readSecret(record));
          const message = yield* mail
            .readMessage(login, messageId)
            .pipe(Effect.mapError(fromMailError));
          if (message === null) return yield* unknownMessage();
          return {
            id: message.uid,
            from: message.from,
            to: message.to,
            cc: message.cc,
            subject: message.subject,
            date: toDate(message.date),
            snippet: message.snippet,
            unread: message.unread,
            text: message.text,
            messageIdHeader: message.messageId,
            references: message.references,
          } satisfies CompanyInboxMessage;
        }
        const token = yield* microsoftAccessToken(record);
        const message = yield* Apis.graphReadMessage(http, token, messageId).pipe(
          Effect.mapError(fromApiError),
        );
        if (message === null) return yield* unknownMessage();
        const references =
          message.internetMessageHeaders
            ?.find((header) => header.name.toLowerCase() === "references")
            ?.value.split(/\s+/)
            .filter((value) => value.length > 0) ?? [];
        return {
          id: message.id,
          from: Apis.formatGraphRecipient(message.from ?? undefined),
          to: (message.toRecipients ?? []).map(Apis.formatGraphRecipient),
          cc: (message.ccRecipients ?? []).map(Apis.formatGraphRecipient),
          subject: message.subject ?? "",
          date: toDate(message.receivedDateTime),
          snippet: (message.bodyPreview ?? "").slice(0, 200),
          unread: message.isRead === false,
          text: message.body?.content ?? message.bodyPreview ?? "",
          messageIdHeader: message.internetMessageId ?? null,
          references,
        } satisfies CompanyInboxMessage;
      }),
    );
  });

  const readMessage: CompanyChannels["Service"]["readMessage"] = Effect.fn(
    "CompanyChannels.readMessage",
  )(function* (input) {
    return yield* readMessageFrom(
      yield* emailRecord(input.projectId, input.accountId),
      input.messageId,
    );
  });

  const outboxDirectory = Effect.fn("CompanyChannels.outboxDirectory")(function* (
    workspaceRoot: string,
  ) {
    return yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: OUTBOX_DIR })
      .pipe(Effect.catch(storageFailure("The project's outbox folder is outside the project.")));
  });

  type DraftRead =
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Malformed"; readonly message: string }
    | { readonly _tag: "Draft"; readonly draft: CompanyDraft };

  const readDraft = Effect.fn("CompanyChannels.readDraft")(function* (
    workspaceRoot: string,
    id: CompanyDraftId,
  ) {
    const file = yield* workspaceFiles
      .readFile({ cwd: workspaceRoot, relativePath: draftPath(id), allowMissing: true })
      .pipe(Effect.catch(storageFailure("Could not read the draft.")));
    if (file.exists === false) return { _tag: "Missing" } satisfies DraftRead;
    if (file.truncated) {
      return { _tag: "Malformed", message: "The draft is too large to read." } satisfies DraftRead;
    }
    const parsed = parseDraft(id, file.contents);
    return parsed._tag === "Malformed"
      ? ({ _tag: "Malformed", message: parsed.error.message } satisfies DraftRead)
      : ({ _tag: "Draft", draft: parsed.draft } satisfies DraftRead);
  });

  const writeDraft = (workspaceRoot: string, draft: CompanyDraft) =>
    Effect.try({
      try: () => serializeDraft(draft),
      catch: () =>
        channelError(
          "invalid_input",
          "The draft has a field it cannot save, such as an empty address.",
        ),
    }).pipe(
      Effect.flatMap((contents) =>
        workspaceFiles
          .writeFile({ cwd: workspaceRoot, relativePath: draft.path, contents })
          .pipe(Effect.catch(storageFailure("Could not save the draft."))),
      ),
      Effect.as(draft),
    );

  const requireDraft = Effect.fn("CompanyChannels.requireDraft")(function* (
    workspaceRoot: string,
    id: CompanyDraftId,
  ) {
    const read = yield* readDraft(workspaceRoot, id);
    if (read._tag === "Missing") {
      return yield* channelError("unknown_draft", "That draft is not in the outbox anymore.");
    }
    if (read._tag === "Malformed") {
      return yield* channelError("invalid_input", `The draft file is malformed: ${read.message}`);
    }
    return read.draft;
  });

  /** One change to a draft at a time in this process; others are refused, not queued. */
  const withDraftLock = <A, E, R>(
    projectId: ProjectId,
    id: CompanyDraftId,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const key = `${projectId}\u0000${id}`;
    return Effect.acquireUseRelease(
      Ref.modify(busyDrafts, (busy) =>
        busy.has(key) ? [false, busy] : [true, new Set([...busy, key])],
      ).pipe(
        Effect.filterOrFail(
          (acquired) => acquired,
          () => channelError("busy", "That draft is being sent or changed. Try again in a moment."),
        ),
      ),
      () => effect,
      () =>
        Ref.update(busyDrafts, (busy) => {
          const next = new Set(busy);
          next.delete(key);
          return next;
        }),
    );
  };

  const listOutbox: CompanyChannels["Service"]["listOutbox"] = Effect.fn(
    "CompanyChannels.listOutbox",
  )(function* (projectId) {
    const project = yield* requireProject(projectId);
    const directory = yield* outboxDirectory(project.workspaceRoot);
    const names = yield* fileSystem.readDirectory(directory.absolutePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as ReadonlyArray<string>),
      ),
      Effect.catch(storageFailure("Could not list the outbox.")),
    );
    const drafts: Array<CompanyDraft> = [];
    const malformed: Array<CompanyMalformedDraft> = [];
    const results = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".md")).toSorted(),
      (name) => {
        const id = draftIdFromFileName(name);
        return id === null
          ? Effect.succeed({
              path: `${OUTBOX_DIR}/${name}`,
              read: {
                _tag: "Malformed",
                message: "Draft file names use lowercase letters, digits, and dashes.",
              } as DraftRead,
            })
          : readDraft(project.workspaceRoot, id).pipe(
              Effect.map((read) => ({ path: draftPath(id), read })),
              Effect.catchTags({
                CompanyChannelError: (error) =>
                  Effect.succeed({
                    path: draftPath(id),
                    read: { _tag: "Malformed", message: error.message } as DraftRead,
                  }),
              }),
            );
      },
      { concurrency: 8 },
    );
    for (const { path: draftFile, read } of results) {
      if (read._tag === "Draft") drafts.push(read.draft);
      else if (read._tag === "Malformed")
        malformed.push({ path: draftFile, message: read.message });
    }
    drafts.sort(
      (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
    );
    return { drafts, malformed };
  });

  const saveDraft: CompanyChannels["Service"]["saveDraft"] = Effect.fn("CompanyChannels.saveDraft")(
    function* (input) {
      const project = yield* requireProject(input.projectId);
      const content = input.draft;
      const record = yield* findRecord(input.projectId, content.accountId);
      if (record.kind !== content.channel) {
        return yield* channelError(
          "invalid_input",
          `That account posts to ${record.kind}, not ${content.channel}.`,
        );
      }
      if (content.channel !== "email" && content.replyToMessageId !== undefined) {
        return yield* channelError("invalid_input", "Only email drafts can reply to a message.");
      }

      const compose = Effect.fn("CompanyChannels.composeDraft")(function* (
        previous: CompanyDraft | undefined,
      ) {
        const now = yield* DateTime.now;
        const replyToMessageId = content.replyToMessageId ?? previous?.replyToMessageId;
        const original =
          replyToMessageId !== undefined && replyToMessageId !== previous?.replyToMessageId
            ? yield* readMessageFrom(record, replyToMessageId)
            : undefined;
        const references =
          original === undefined
            ? previous?.references
            : original.messageIdHeader === null
              ? original.references
              : [...original.references, original.messageIdHeader];
        const to =
          content.to ??
          (original === undefined
            ? previous?.to
            : [bareAddress(original.from)].filter((address) => address !== ""));
        const subject =
          content.subject ??
          (original === undefined ? previous?.subject : replySubject(original.subject));
        const inReplyTo =
          original === undefined ? previous?.inReplyTo : (original.messageIdHeader ?? undefined);
        const id = previous?.id ?? newDraftId(now, subject ?? content.text, yield* randomHex(3));
        const draft: CompanyDraft = {
          id,
          path: draftPath(id),
          channel: content.channel,
          account: content.accountId,
          status: "draft",
          createdBy: previous?.createdBy ?? (input.createdBy?.trim() || "You"),
          createdAt: previous?.createdAt ?? now,
          ...(content.channel === "email"
            ? {
                to: to ?? [],
                ...((content.cc ?? previous?.cc) ? { cc: content.cc ?? previous?.cc ?? [] } : {}),
                subject: subject ?? "",
                ...(inReplyTo === undefined ? {} : { inReplyTo }),
                ...(references === undefined || references.length === 0 ? {} : { references }),
                ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
              }
            : {}),
          body: content.text,
        };
        return yield* writeDraft(project.workspaceRoot, draft);
      });

      if (input.draftId === undefined) return yield* compose(undefined);
      const draftId = input.draftId;
      return yield* withDraftLock(
        input.projectId,
        draftId,
        Effect.gen(function* () {
          const previous = yield* requireDraft(project.workspaceRoot, draftId);
          if (previous.status === "sent") {
            return yield* channelError("not_sendable", "This draft was already sent.");
          }
          return yield* compose(previous);
        }),
      );
    },
  );

  const discardDraft: CompanyChannels["Service"]["discardDraft"] = Effect.fn(
    "CompanyChannels.discardDraft",
  )(function* (input) {
    const project = yield* requireProject(input.projectId);
    return yield* withDraftLock(
      input.projectId,
      input.draftId,
      Effect.gen(function* () {
        const read = yield* readDraft(project.workspaceRoot, input.draftId);
        if (read._tag === "Missing") return false;
        if (read._tag === "Malformed") {
          return yield* channelError(
            "invalid_input",
            `The draft file is malformed: ${read.message}`,
          );
        }
        if (read.draft.status === "sent") {
          return yield* channelError("not_sendable", "Sent drafts stay in the outbox as a record.");
        }
        const directory = yield* outboxDirectory(project.workspaceRoot);
        yield* fileSystem
          .remove(path.join(directory.absolutePath, `${input.draftId}.md`))
          .pipe(Effect.catch(storageFailure("Could not delete the draft.")));
        return true;
      }),
    );
  });

  /** Sends through the account and says where it went; refusals come back as errors. */
  const deliver = Effect.fn("CompanyChannels.deliver")(function* (
    record: AccountRecord,
    draft: CompanyDraft,
  ) {
    const connection = record.connection;
    switch (connection._tag) {
      case "imap": {
        const login = yield* imapLogin(connection, yield* readSecret(record));
        yield* mail
          .send(
            login,
            {
              from: record.address,
              to: draft.to ?? [],
              cc: draft.cc ?? [],
              subject: draft.subject ?? "",
              text: draft.body,
              inReplyTo: draft.inReplyTo,
              references: draft.references,
            },
            // Gmail files what its SMTP server sends; others need the copy appended.
            { appendToSent: connection.preset !== "gmail" },
          )
          .pipe(Effect.mapError(fromMailError));
        return undefined;
      }
      case "microsoft": {
        const token = yield* microsoftAccessToken(record);
        const message = { to: draft.to ?? [], cc: draft.cc ?? [], text: draft.body };
        yield* (
          draft.replyToMessageId === undefined
            ? Apis.graphSendMail(http, token, { ...message, subject: draft.subject ?? "" })
            : Apis.graphReply(http, token, draft.replyToMessageId, message)
        ).pipe(Effect.mapError(fromApiError));
        return undefined;
      }
      case "x": {
        const secret = yield* readSecret(record);
        if (secret._tag !== "x") {
          return yield* channelError(
            "auth_failed",
            "This account's saved credentials do not match it.",
          );
        }
        const id = yield* Apis.xPost(http, xSigner(secret), draft.body).pipe(
          Effect.mapError(fromApiError),
        );
        const handle = record.address.replace(/^@/, "");
        return handle === ""
          ? `https://x.com/i/web/status/${id}`
          : `https://x.com/${handle}/status/${id}`;
      }
      case "linkedin": {
        const secret = yield* readSecret(record);
        if (secret._tag !== "linkedin") {
          return yield* channelError(
            "auth_failed",
            "This account's saved credentials do not match it.",
          );
        }
        const urn = yield* Apis.linkedInPost(
          http,
          secret.accessToken,
          connection.authorUrn,
          draft.body,
        ).pipe(Effect.mapError(fromApiError));
        return `https://www.linkedin.com/feed/update/${urn}`;
      }
      case "threads": {
        const token = yield* threadsAccessToken(record);
        const published = yield* Apis.threadsPublish(
          http,
          token,
          connection.userId,
          draft.body,
        ).pipe(Effect.mapError(fromApiError));
        return published.permalink ?? undefined;
      }
    }
  });

  const send: CompanyChannels["Service"]["send"] = Effect.fn("CompanyChannels.send")(
    function* (input) {
      const project = yield* requireProject(input.projectId);
      const key = `${input.projectId}\u0000${input.draftId}`;
      return yield* withDraftLock(
        input.projectId,
        input.draftId,
        Effect.gen(function* () {
          const draft = yield* requireDraft(project.workspaceRoot, input.draftId);
          if (draft.status === "sent" || (yield* Ref.get(sentUnrecorded)).has(key)) {
            return yield* channelError("not_sendable", "This draft was already sent.");
          }
          const record = yield* findRecord(input.projectId, draft.account);
          if (record.kind !== draft.channel) {
            return yield* channelError(
              "invalid_input",
              `The draft is for ${draft.channel}, but its account posts to ${record.kind}.`,
            );
          }
          const limit = POST_LIMITS[draft.channel];
          const length = codePoints(draft.body.trim());
          if (limit !== undefined && length > limit) {
            return yield* channelError(
              "too_long",
              `The post is ${length} characters; ${draft.channel === "x" ? "X" : draft.channel === "linkedin" ? "LinkedIn" : "Threads"} allows ${limit}.`,
            );
          }
          if (length === 0) return yield* channelError("invalid_input", "The draft is empty.");
          if (
            draft.channel === "email" &&
            (draft.to ?? []).length === 0 &&
            draft.replyToMessageId === undefined
          ) {
            return yield* channelError("invalid_input", "Add a recipient before sending.");
          }
          const outcome = yield* tracked(
            record,
            deliver(record, { ...draft, body: draft.body.trim() }),
          ).pipe(
            Effect.map((url) => ({ _tag: "Sent", url }) as const),
            Effect.catchTags({
              CompanyChannelError: (error) =>
                error.reason === "storage"
                  ? Effect.fail(error)
                  : Effect.succeed({ _tag: "Failed", error: error.message } as const),
            }),
          );
          const { error: _error, url: _url, sentAt: _sentAt, ...rest } = draft;
          const now = yield* DateTime.now;
          const next: CompanyDraft =
            outcome._tag === "Sent"
              ? {
                  ...rest,
                  status: "sent",
                  sentAt: now,
                  ...(outcome.url === undefined ? {} : { url: outcome.url }),
                }
              : { ...rest, status: "failed", error: outcome.error };
          return yield* writeDraft(project.workspaceRoot, next).pipe(
            Effect.tapError(() =>
              outcome._tag === "Sent"
                ? Ref.update(sentUnrecorded, (sent) => new Set([...sent, key]))
                : Effect.void,
            ),
          );
        }),
      );
    },
  );

  return CompanyChannels.of({
    listAccounts,
    saveAccount,
    removeAccount,
    microsoftSignInStart,
    microsoftSignInWait,
    microsoftSignInCancel,
    listInbox,
    readMessage,
    listOutbox,
    saveDraft,
    discardDraft,
    send,
  });
});

export const layer = Layer.effect(CompanyChannels, make);
