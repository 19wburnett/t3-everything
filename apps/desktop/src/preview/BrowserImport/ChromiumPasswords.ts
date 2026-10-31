import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { decryptChromiumValue } from "./ChromiumCookies.ts";
import {
  resolveChromiumSourceKeys,
  type ChromiumKeyMaterial,
  type ChromiumKeySource,
} from "./ChromiumKeys.ts";
import { snapshotCookieDatabase } from "./CookieDatabase.ts";
import { BrowserPasswordReadError, toImportEntries } from "./Passwords.ts";

const LoginRow = Schema.Struct({
  origin_url: Schema.String,
  username_value: Schema.String,
  password_value: Schema.Uint8Array,
});
const decodeLoginRows = Schema.decodeUnknownEffect(Schema.Array(LoginRow));

const isV11 = (value: Uint8Array) => Buffer.from(value.subarray(0, 3)).toString("latin1") === "v11";

export const readChromiumLoginDatabase = Effect.fn("ChromiumPasswords.readChromiumLoginDatabase")(
  function* (snapshotPath: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform) {
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* decodeLoginRows(
        yield* sql`select origin_url, coalesce(username_value, '') as username_value, password_value
          from logins
          where blacklisted_by_user = 0 and length(password_value) > 0`,
      ).pipe(Effect.mapError(() => new BrowserPasswordReadError({ reason: "readFailed" })));
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })),
      Effect.mapError((cause) =>
        cause._tag === "BrowserPasswordReadError"
          ? cause
          : new BrowserPasswordReadError({ reason: "readFailed", cause }),
      ),
    );

    // Login Data values carry no domain-hash prefix; schema version 0 skips stripping one.
    const entries = toImportEntries(
      rows.map((row) => ({
        url: row.origin_url,
        username: row.username_value,
        password: decryptChromiumValue(row.password_value, keys, "", 0, platform),
      })),
    );
    if (
      entries.length === 0 &&
      keys.cbcV11Error !== undefined &&
      rows.some((row) => isV11(row.password_value))
    ) {
      return yield* new BrowserPasswordReadError({
        reason: keys.cbcV11Error.reason,
        cause: keys.cbcV11Error,
      });
    }
    return entries;
  },
);

export const readChromiumPasswords = Effect.fn("ChromiumPasswords.readChromiumPasswords")(
  function* (source: ChromiumKeySource & { readonly loginDatabasePath: string }) {
    const keys = yield* resolveChromiumSourceKeys(source).pipe(
      Effect.mapError((cause) => new BrowserPasswordReadError({ reason: cause.reason, cause })),
    );
    const snapshotPath = yield* snapshotCookieDatabase(
      source.loginDatabasePath,
      "t3code-password-import-",
    ).pipe(
      Effect.mapError((cause) => new BrowserPasswordReadError({ reason: "readFailed", cause })),
    );
    return yield* readChromiumLoginDatabase(snapshotPath, keys, source.platform);
  },
);
