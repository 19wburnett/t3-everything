// @effect-diagnostics nodeBuiltinImport:off - Encrypts fixtures with the same
// OSCrypt primitives the module under test decrypts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { ChromiumKeyError } from "./ChromiumKeys.ts";
import { readChromiumLoginDatabase } from "./ChromiumPasswords.ts";

const encrypt = (prefix: "v10" | "v11", value: string, key: Buffer): Uint8Array => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(value), cipher.final()]);
};

const writeLoginDatabase = Effect.fnUntraced(function* (
  rows: ReadonlyArray<
    readonly [origin: string, username: string, password: Uint8Array, blacklisted: number]
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-login-data-" });
  const filename = `${directory}/Login Data`;
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`create table logins (
      origin_url varchar not null, action_url varchar, username_element varchar,
      username_value varchar, password_element varchar, password_value blob,
      signon_realm varchar not null, blacklisted_by_user integer not null
    )`;
    for (const [origin, username, password, blacklisted] of rows) {
      yield* sql`insert into logins (origin_url, username_value, password_value, signon_realm, blacklisted_by_user)
        values (${origin}, ${username}, ${password}, ${origin}, ${blacklisted})`;
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  return filename;
});

describe("readChromiumLoginDatabase", () => {
  it.effect("decrypts web logins and skips blacklisted, empty, and app rows", () =>
    Effect.gen(function* () {
      const key = Buffer.from("0123456789abcdef");
      const filename = yield* writeLoginDatabase([
        ["https://example.test/login?next=/", "ada", encrypt("v10", "hunter2", key), 0],
        ["https://example.test/other", "ada", encrypt("v10", "duplicate", key), 0],
        ["http://localhost:3000/", "", encrypt("v10", "local", key), 0],
        ["https://never.test/", "", new Uint8Array(), 1],
        ["https://blocked.test/", "bob", encrypt("v10", "blocked", key), 1],
        ["https://empty.test/", "carol", encrypt("v10", "", key), 0],
        ["android://hash@com.example.app/", "dan", encrypt("v10", "app", key), 0],
        ["https://wrong-key.test/", "erin", encrypt("v10", "x", Buffer.alloc(16, 1)), 0],
      ]);

      const entries = yield* readChromiumLoginDatabase(filename, { cbcV10: key }, "linux");

      expect(entries).toEqual([
        { origin: "https://example.test", username: "ada", password: "hunter2" },
        { origin: "http://localhost:3000", username: "", password: "local" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the keyring failure when only v11 logins exist", () =>
    Effect.gen(function* () {
      const filename = yield* writeLoginDatabase([
        ["https://example.test/", "ada", encrypt("v11", "hunter2", Buffer.alloc(16, 2)), 0],
      ]);

      const error = yield* readChromiumLoginDatabase(
        filename,
        {
          cbcV10: Buffer.alloc(16, 1),
          cbcV11Error: new ChromiumKeyError({ reason: "keychainUnavailable" }),
        },
        "linux",
      ).pipe(Effect.flip);

      expect(error.reason).toBe("keychainUnavailable");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
