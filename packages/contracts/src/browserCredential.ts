import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Saved logins agents can fill in the preview browser. Values never leave the server. */
export const BrowserCredentialId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type BrowserCredentialId = typeof BrowserCredentialId.Type;

export const BrowserCredentialSource = Schema.Literals(["browser", "one_password", "bitwarden"]);
export type BrowserCredentialSource = typeof BrowserCredentialSource.Type;

export const BrowserCredentialManager = Schema.Literals(["one_password", "bitwarden"]);
export type BrowserCredentialManager = typeof BrowserCredentialManager.Type;

/** What clients and agents see of a saved login. */
export const BrowserCredential = Schema.Struct({
  id: BrowserCredentialId,
  /** `scheme://host[:port]` the login may be filled on, including its subdomains. */
  origin: Schema.String,
  username: Schema.String,
  source: BrowserCredentialSource,
  /** Where it came from, such as "Chrome (Default)" or a 1Password vault. */
  sourceName: Schema.String,
});
export type BrowserCredential = typeof BrowserCredential.Type;

export const BrowserCredentialManagerStatus = Schema.Literals([
  "not_installed",
  "signed_out",
  "locked",
  "ready",
]);
export type BrowserCredentialManagerStatus = typeof BrowserCredentialManagerStatus.Type;

export const BrowserCredentialListResult = Schema.Struct({
  credentials: Schema.Array(BrowserCredential),
  managers: Schema.Struct({
    one_password: BrowserCredentialManagerStatus,
    bitwarden: BrowserCredentialManagerStatus,
  }),
});
export type BrowserCredentialListResult = typeof BrowserCredentialListResult.Type;

const MAX_IMPORT_ENTRIES = 20_000;

export const BrowserCredentialImportEntry = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  username: Schema.String.check(Schema.isMaxLength(1024)),
  password: Schema.String.check(Schema.isMaxLength(4096)),
});
export type BrowserCredentialImportEntry = typeof BrowserCredentialImportEntry.Type;

/** Replaces every login previously imported under the same `sourceName`. */
export const BrowserCredentialImportInput = Schema.Struct({
  sourceName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  entries: Schema.Array(BrowserCredentialImportEntry).check(Schema.isMaxLength(MAX_IMPORT_ENTRIES)),
});
export type BrowserCredentialImportInput = typeof BrowserCredentialImportInput.Type;

export const BrowserCredentialImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
});
export type BrowserCredentialImportResult = typeof BrowserCredentialImportResult.Type;

/** Replaces every login previously synced from that manager. Values stay in the manager. */
export const BrowserCredentialSyncInput = Schema.Struct({
  manager: BrowserCredentialManager,
});
export type BrowserCredentialSyncInput = typeof BrowserCredentialSyncInput.Type;

export const BrowserCredentialUnlockInput = Schema.Struct({
  masterPassword: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
});
export type BrowserCredentialUnlockInput = typeof BrowserCredentialUnlockInput.Type;

export const BrowserCredentialRemoveInput = Schema.Struct({
  credentialIds: Schema.Array(BrowserCredentialId).check(Schema.isMaxLength(MAX_IMPORT_ENTRIES)),
});
export type BrowserCredentialRemoveInput = typeof BrowserCredentialRemoveInput.Type;

const BROWSER_CREDENTIAL_FAILURE_MESSAGES = {
  store_failed: "Could not save logins.",
  read_failed: "Could not read saved logins.",
  not_found: "That saved login no longer exists. Check preview_status for current logins.",
  origin_mismatch:
    "That login belongs to another site. Navigate to its site first; logins only fill on their own origin.",
  manager_not_installed: "That password manager's command-line tool is not installed on the host.",
  manager_signed_out: "Sign in to the password manager's command-line tool on the host first.",
  manager_locked: "Bitwarden is locked. Unlock it in Settings → Browser → Saved logins.",
  manager_failed: "The password manager did not return the login.",
  unlock_failed: "Bitwarden did not unlock. Check the master password.",
} as const;

export const BrowserCredentialFailureReason = Schema.Literals(
  Object.keys(BROWSER_CREDENTIAL_FAILURE_MESSAGES) as Array<
    keyof typeof BROWSER_CREDENTIAL_FAILURE_MESSAGES
  >,
);
export type BrowserCredentialFailureReason = typeof BrowserCredentialFailureReason.Type;

export class BrowserCredentialError extends Schema.TaggedError<BrowserCredentialError>()(
  "BrowserCredentialError",
  {
    reason: BrowserCredentialFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return BROWSER_CREDENTIAL_FAILURE_MESSAGES[this.reason];
  }
}
