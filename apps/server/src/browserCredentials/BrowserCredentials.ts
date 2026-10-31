// Saved logins agents fill into preview pages. Passwords stay on this server: clients and agents see
// only metadata, and password manager logins are read from the manager at fill time.
import {
  BrowserCredential,
  BrowserCredentialError,
  type BrowserCredentialId,
  type BrowserCredentialImportInput,
  type BrowserCredentialImportResult,
  type BrowserCredentialListResult,
  type BrowserCredentialManager,
  type BrowserCredentialRemoveInput,
  type BrowserCredentialSyncInput,
  type BrowserCredentialUnlockInput,
} from "@t3tools/contracts";
import { OnePasswordSecretProviderConfig } from "@t3tools/secret-provider-onepassword/shared/definition";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { credentialMatchesUrl, normalizeCredentialOrigin } from "./origin.ts";
import * as PasswordManagers from "./passwordManagers.ts";

const STORE_NAME = "browser-credentials";
const BITWARDEN_PASSWORD_ENV = "T3_BW_PASSWORD";

const StoredSecret = Schema.Union([
  Schema.Struct({ type: Schema.Literal("stored"), password: Schema.String }),
  Schema.Struct({ type: Schema.Literal("one_password"), reference: Schema.String }),
  Schema.Struct({ type: Schema.Literal("bitwarden"), itemId: Schema.String }),
]);
const StoredCredential = Schema.Struct({ ...BrowserCredential.fields, secret: StoredSecret });
type StoredCredential = typeof StoredCredential.Type;
const StoredCredentials = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), credentials: Schema.Array(StoredCredential) }),
);
const decodeStored = Schema.decodeUnknownOption(StoredCredentials);
const encodeStored = Schema.encodeSync(StoredCredentials);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);

const failWith = (reason: BrowserCredentialError["reason"]) =>
  Effect.fail(new BrowserCredentialError({ reason }));

const toPublic = ({ secret: _secret, ...credential }: StoredCredential): BrowserCredential =>
  credential;

const loginKey = (origin: string, username: string) => `${origin}\u0000${username}`;

const managerKey = (secret: StoredCredential["secret"]) =>
  secret.type === "stored"
    ? undefined
    : secret.type === "one_password"
      ? secret.reference
      : secret.itemId;

// `bw get` ends its output with a newline that is not part of the password.
const withoutTrailingNewline = (value: string) => value.replace(/\r?\n$/, "");

export class BrowserCredentials extends Context.Service<
  BrowserCredentials,
  {
    readonly list: Effect.Effect<BrowserCredentialListResult, BrowserCredentialError>;
    /** Replaces every login imported before under the same `sourceName`. */
    readonly import: (
      input: BrowserCredentialImportInput,
    ) => Effect.Effect<BrowserCredentialImportResult, BrowserCredentialError>;
    /** Replaces every login synced before from that manager. */
    readonly sync: (
      input: BrowserCredentialSyncInput,
    ) => Effect.Effect<BrowserCredentialImportResult, BrowserCredentialError>;
    readonly unlockBitwarden: (
      input: BrowserCredentialUnlockInput,
    ) => Effect.Effect<void, BrowserCredentialError>;
    readonly lockBitwarden: Effect.Effect<void>;
    readonly remove: (
      input: BrowserCredentialRemoveInput,
    ) => Effect.Effect<void, BrowserCredentialError>;
    /** Logins that may be filled on `url`. */
    readonly matching: (
      url: string,
    ) => Effect.Effect<ReadonlyArray<BrowserCredential>, BrowserCredentialError>;
    /** The value to fill, only when the login belongs to `url`'s site. */
    readonly resolveForFill: (input: {
      readonly credentialId: BrowserCredentialId;
      readonly field: "username" | "password";
      readonly url: string;
    }) => Effect.Effect<string, BrowserCredentialError>;
  }
>()("t3/browserCredentials/BrowserCredentials") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const cliServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const lock = yield* Semaphore.make(1);
  // Every write goes through this service, so the decoded store is kept after the first read.
  const cache = yield* Ref.make(Option.none<ReadonlyArray<StoredCredential>>());
  // The Bitwarden session key lives only in memory; a restart locks Bitwarden again.
  const bitwardenSession = yield* Ref.make(Option.none<string>());

  const run = (...args: Parameters<typeof PasswordManagers.runCli>) =>
    PasswordManagers.runCli(...args).pipe(Effect.provide(cliServices));

  // Decode failures carry no cause: schema issues can quote the stored passwords.
  const loadUnlocked = Effect.gen(function* () {
    const cached = yield* Ref.get(cache);
    if (Option.isSome(cached)) return cached.value;
    const bytes = yield* store
      .get(STORE_NAME)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialError({ reason: "read_failed", cause })),
      );
    if (Option.isNone(bytes)) return [];
    const decoded = decodeStored(new TextDecoder().decode(bytes.value));
    if (Option.isNone(decoded)) return yield* failWith("read_failed");
    yield* Ref.set(cache, Option.some(decoded.value.credentials));
    return decoded.value.credentials;
  });
  const load = lock.withPermits(1)(loadUnlocked);

  const modify = <A, E>(
    change: (
      current: ReadonlyArray<StoredCredential>,
    ) => Effect.Effect<readonly [A, ReadonlyArray<StoredCredential>], E>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = yield* change(yield* loadUnlocked);
        yield* store
          .set(
            STORE_NAME,
            new TextEncoder().encode(encodeStored({ version: 1, credentials: next })),
          )
          .pipe(
            Effect.mapError(
              (cause) => new BrowserCredentialError({ reason: "store_failed", cause }),
            ),
          );
        yield* Ref.set(cache, Option.some(next));
        return result;
      }),
    );

  const newId = (previous: string | undefined) =>
    previous === undefined
      ? crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(
              (cause) => new BrowserCredentialError({ reason: "store_failed", cause }),
            ),
          )
      : Effect.succeed(previous);

  const onePasswordAccount = settings.getSettings.pipe(
    Effect.map((current) => {
      const provider = Object.values(current.secretProviders).find(
        (candidate) => candidate.kind === "one_password",
      );
      return provider === undefined
        ? undefined
        : Option.getOrUndefined(decodeOnePasswordConfig(provider.config))?.account;
    }),
    Effect.orElseSucceed(() => undefined),
  );

  const runOnePassword = (
    account: string | undefined,
    args: ReadonlyArray<string>,
    timeout: Parameters<typeof PasswordManagers.runCli>[2],
  ) => run("op", PasswordManagers.onePasswordArgs(account, args), timeout);

  const onePasswordStatus = Effect.gen(function* () {
    const account = yield* onePasswordAccount;
    return PasswordManagers.onePasswordStatus(
      yield* runOnePassword(account, ["whoami"], PasswordManagers.STATUS_TIMEOUT),
    );
  });

  const bitwardenStatus = Effect.gen(function* () {
    const session = Option.getOrUndefined(yield* Ref.get(bitwardenSession));
    const status = PasswordManagers.bitwardenStatus(
      yield* run(
        "bw",
        PasswordManagers.bitwardenArgs(["status"]),
        PasswordManagers.STATUS_TIMEOUT,
        session === undefined ? undefined : { BW_SESSION: session },
      ),
      session !== undefined,
    );
    // A session key Bitwarden no longer accepts would only fail later fills.
    if (session !== undefined && status !== "ready")
      yield* Ref.set(bitwardenSession, Option.none());
    return status;
  });

  /** Explains a failed manager run by its current status. */
  const managerFailure = (manager: BrowserCredentialManager) =>
    (manager === "one_password" ? onePasswordStatus : bitwardenStatus).pipe(
      Effect.flatMap((status) =>
        failWith(
          status === "not_installed"
            ? "manager_not_installed"
            : status === "signed_out"
              ? "manager_signed_out"
              : status === "locked"
                ? "manager_locked"
                : "manager_failed",
        ),
      ),
    );

  const outputOf = (manager: BrowserCredentialManager, outcome: PasswordManagers.CliOutcome) => {
    if (outcome._tag === "missing") return failWith("manager_not_installed");
    if (outcome._tag === "timeout") return failWith("manager_failed");
    if (outcome.code !== 0) {
      return Effect.logWarning("Password manager command failed", {
        manager,
        exitCode: outcome.code,
      }).pipe(Effect.andThen(managerFailure(manager)));
    }
    return Effect.succeed(outcome.stdout);
  };

  const requireBitwardenSession = Ref.get(bitwardenSession).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => failWith("manager_locked"),
        onSome: (session) => Effect.succeed({ BW_SESSION: session }),
      }),
    ),
  );

  const listOnePassword = Effect.gen(function* () {
    const account = yield* onePasswordAccount;
    const stdout = yield* outputOf(
      "one_password",
      yield* runOnePassword(
        account,
        ["item", "list", "--categories", "Login", "--format", "json"],
        PasswordManagers.SYNC_TIMEOUT,
      ),
    );
    return PasswordManagers.parseOnePasswordItems(stdout);
  });

  const listBitwarden = Effect.gen(function* () {
    const env = yield* requireBitwardenSession;
    const synced = yield* run(
      "bw",
      PasswordManagers.bitwardenArgs(["sync"]),
      PasswordManagers.SYNC_TIMEOUT,
      env,
    );
    // Offline, the local vault is still worth listing.
    if (synced._tag !== "exited" || synced.code !== 0) {
      yield* Effect.logWarning("Bitwarden sync failed; listing the local vault", {
        outcome: synced._tag,
      });
    }
    const stdout = yield* outputOf(
      "bitwarden",
      yield* run(
        "bw",
        PasswordManagers.bitwardenArgs(["list", "items"]),
        PasswordManagers.SYNC_TIMEOUT,
        env,
      ),
    );
    return PasswordManagers.parseBitwardenItems(stdout);
  });

  const list: BrowserCredentials["Service"]["list"] = Effect.gen(function* () {
    const credentials = yield* load;
    const [onePassword, bitwarden] = yield* Effect.all([onePasswordStatus, bitwardenStatus], {
      concurrency: "unbounded",
    });
    return {
      credentials: credentials.map(toPublic),
      managers: { one_password: onePassword, bitwarden },
    };
  }).pipe(Effect.withSpan("BrowserCredentials.list"));

  const importLogins: BrowserCredentials["Service"]["import"] = Effect.fn(
    "BrowserCredentials.import",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "browser_credentials.entries": input.entries.length });
    const seen = new Set<string>();
    const fresh: Array<{ origin: string; username: string; password: string }> = [];
    for (const entry of input.entries) {
      const origin = normalizeCredentialOrigin(entry.origin);
      if (origin === undefined || entry.password.length === 0) continue;
      const key = loginKey(origin, entry.username);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ origin, username: entry.username, password: entry.password });
    }
    const replaced = (credential: StoredCredential) =>
      credential.source === "browser" && credential.sourceName === input.sourceName;
    return yield* modify((current) =>
      Effect.gen(function* () {
        const previousIds = new Map(
          current
            .filter(replaced)
            .map((credential) => [loginKey(credential.origin, credential.username), credential.id]),
        );
        const added = yield* Effect.forEach(fresh, (entry) =>
          newId(previousIds.get(loginKey(entry.origin, entry.username))).pipe(
            Effect.map((id): StoredCredential => ({
              id,
              origin: entry.origin,
              username: entry.username,
              source: "browser",
              sourceName: input.sourceName,
              secret: { type: "stored", password: entry.password },
            })),
          ),
        );
        return [
          { imported: added.length, skipped: input.entries.length - added.length },
          [...current.filter((credential) => !replaced(credential)), ...added],
        ] as const;
      }),
    );
  });

  const sync: BrowserCredentials["Service"]["sync"] = Effect.fn("BrowserCredentials.sync")(
    function* ({ manager }) {
      yield* Effect.annotateCurrentSpan({ "browser_credentials.manager": manager });
      const items = manager === "one_password" ? yield* listOnePassword : yield* listBitwarden;
      if (items === undefined) {
        yield* Effect.logWarning("Password manager returned an unreadable item list", { manager });
        return yield* failWith("manager_failed");
      }
      const logins = items.filter(Predicate.isNotUndefined);
      return yield* modify((current) =>
        Effect.gen(function* () {
          const previousIds = new Map(
            current.flatMap((credential) => {
              const key = credential.source === manager ? managerKey(credential.secret) : undefined;
              return key === undefined ? [] : [[key, credential.id] as const];
            }),
          );
          const added = yield* Effect.forEach(logins, (login) =>
            newId(previousIds.get(managerKey(login.secret) ?? "")).pipe(
              Effect.map((id): StoredCredential => ({
                id,
                origin: login.origin,
                username: login.username,
                source: manager,
                sourceName: login.sourceName,
                secret: login.secret,
              })),
            ),
          );
          return [
            { imported: added.length, skipped: items.length - added.length },
            [...current.filter((credential) => credential.source !== manager), ...added],
          ] as const;
        }),
      );
    },
  );

  const unlockBitwarden: BrowserCredentials["Service"]["unlockBitwarden"] = Effect.fn(
    "BrowserCredentials.unlockBitwarden",
  )(function* ({ masterPassword }) {
    const outcome = yield* run(
      "bw",
      PasswordManagers.bitwardenArgs(["unlock", "--raw", "--passwordenv", BITWARDEN_PASSWORD_ENV]),
      PasswordManagers.STATUS_TIMEOUT,
      { [BITWARDEN_PASSWORD_ENV]: masterPassword },
    );
    if (outcome._tag === "missing") return yield* failWith("manager_not_installed");
    const session = outcome._tag === "exited" && outcome.code === 0 ? outcome.stdout.trim() : "";
    if (session.length > 0) {
      yield* Ref.set(bitwardenSession, Option.some(session));
      return;
    }
    yield* Ref.set(bitwardenSession, Option.none());
    return yield* (yield* bitwardenStatus) === "signed_out"
      ? failWith("manager_signed_out")
      : failWith("unlock_failed");
  });

  const lockBitwarden: BrowserCredentials["Service"]["lockBitwarden"] = Ref.set(
    bitwardenSession,
    Option.none(),
  ).pipe(
    Effect.andThen(
      run("bw", PasswordManagers.bitwardenArgs(["lock"]), PasswordManagers.STATUS_TIMEOUT),
    ),
    Effect.asVoid,
    Effect.withSpan("BrowserCredentials.lockBitwarden"),
  );

  const remove: BrowserCredentials["Service"]["remove"] = Effect.fn("BrowserCredentials.remove")(
    function* ({ credentialIds }) {
      const removed = new Set<string>(credentialIds);
      yield* modify((current) =>
        Effect.succeed([
          undefined,
          current.filter((credential) => !removed.has(credential.id)),
        ] as const),
      );
    },
  );

  const matching: BrowserCredentials["Service"]["matching"] = Effect.fn(
    "BrowserCredentials.matching",
  )(function* (url) {
    const credentials = yield* load;
    return credentials
      .filter((credential) => credentialMatchesUrl(credential.origin, url))
      .map(toPublic);
  });

  const readPassword = Effect.fn("BrowserCredentials.readPassword")(function* (
    secret: StoredCredential["secret"],
  ) {
    yield* Effect.annotateCurrentSpan({ "browser_credentials.source": secret.type });
    switch (secret.type) {
      case "stored":
        return secret.password;
      case "one_password": {
        const account = yield* onePasswordAccount;
        return yield* outputOf(
          "one_password",
          yield* runOnePassword(
            account,
            ["read", "--no-newline", secret.reference],
            PasswordManagers.READ_TIMEOUT,
          ),
        );
      }
      case "bitwarden": {
        const env = yield* requireBitwardenSession;
        const stdout = yield* outputOf(
          "bitwarden",
          yield* run(
            "bw",
            PasswordManagers.bitwardenArgs(["get", "password", secret.itemId]),
            PasswordManagers.READ_TIMEOUT,
            env,
          ),
        );
        return withoutTrailingNewline(stdout);
      }
    }
  });

  const resolveForFill: BrowserCredentials["Service"]["resolveForFill"] = Effect.fn(
    "BrowserCredentials.resolveForFill",
  )(function* ({ credentialId, field, url }) {
    yield* Effect.annotateCurrentSpan({ "browser_credentials.field": field });
    const credential = (yield* load).find((candidate) => candidate.id === credentialId);
    if (credential === undefined) return yield* failWith("not_found");
    if (!credentialMatchesUrl(credential.origin, url)) return yield* failWith("origin_mismatch");
    if (field === "username") return credential.username;
    const password = yield* readPassword(credential.secret);
    if (password.length === 0) return yield* failWith("manager_failed");
    return password;
  });

  return BrowserCredentials.of({
    list,
    import: importLogins,
    sync,
    unlockBitwarden,
    lockBitwarden,
    remove,
    matching,
    resolveForFill,
  });
});

export const layer = Layer.effect(BrowserCredentials, make);
