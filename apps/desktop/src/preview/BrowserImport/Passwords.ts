import { BrowserCredentialImportEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ChromiumKeyFailure } from "./ChromiumKeys.ts";

export const BrowserPasswordReadReason = Schema.Literals([
  ...ChromiumKeyFailure.literals,
  "primaryPasswordSet",
]);
export type BrowserPasswordReadReason = typeof BrowserPasswordReadReason.Type;

/** Never attach decoded rows or plaintext as the cause; IPC and logs would carry them. */
export class BrowserPasswordReadError extends Schema.TaggedError<BrowserPasswordReadError>()(
  "BrowserPasswordReadError",
  {
    reason: BrowserPasswordReadReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read saved passwords: ${this.reason}.`;
  }
}

export interface DecryptedLogin {
  readonly url: string;
  readonly username: string | null;
  readonly password: string | null;
}

const isImportEntry = Schema.is(BrowserCredentialImportEntry);

const webOrigin = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Keeps web logins only, one per origin and username, within the import contract's limits. */
export const toImportEntries = (
  logins: Iterable<DecryptedLogin>,
): ReadonlyArray<BrowserCredentialImportEntry> => {
  const entries = new Map<string, BrowserCredentialImportEntry>();
  for (const login of logins) {
    if (login.username === null || !login.password) continue;
    const origin = webOrigin(login.url);
    if (origin === undefined) continue;
    const entry = { origin, username: login.username, password: login.password };
    const key = JSON.stringify([origin, login.username]);
    if (!entries.has(key) && isImportEntry(entry)) entries.set(key, entry);
  }
  return [...entries.values()];
};
