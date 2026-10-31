// @effect-diagnostics nodeBuiltinImport:off - Encrypts fixtures with the
// NSS ciphers the module under test decrypts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { readFirefoxPasswords } from "./FirefoxPasswords.ts";

const der = (tag: number, ...content: ReadonlyArray<Buffer>) => {
  const body = Buffer.concat(content);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...content: ReadonlyArray<Buffer>) => der(0x30, ...content);
const octets = (value: Buffer) => der(0x04, value);
const integer = (value: number) => der(0x02, Buffer.from([value >> 8, value & 0xff]));
const oid = (dotted: string) => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};

const encrypt = (algorithm: string, key: Buffer, iv: Buffer, plaintext: Buffer) => {
  const cipher = NodeCrypto.createCipheriv(algorithm, key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
};
const sha1 = (...parts: ReadonlyArray<Buffer>) =>
  NodeCrypto.createHash("sha1").update(Buffer.concat(parts)).digest();

const GLOBAL_SALT = Buffer.alloc(20, 7);
const CKA_ID = Buffer.from("f8000000000000000000000000000001", "hex");

const pbes2Item = (plaintext: Buffer, password = "") => {
  const salt = Buffer.alloc(32, 3);
  const iv = Buffer.alloc(14, 4);
  const key = NodeCrypto.pbkdf2Sync(
    sha1(GLOBAL_SALT, Buffer.from(password)),
    salt,
    10,
    32,
    "sha256",
  );
  const ciphertext = encrypt(
    "aes-256-cbc",
    key,
    Buffer.concat([Buffer.from([4, 14]), iv]),
    plaintext,
  );
  return sequence(
    sequence(
      oid("1.2.840.113549.1.5.13"),
      sequence(
        sequence(
          oid("1.2.840.113549.1.5.12"),
          sequence(
            octets(salt),
            integer(10),
            integer(32),
            sequence(oid("1.2.840.113549.2.9"), Buffer.from([5, 0])),
          ),
        ),
        sequence(oid("2.16.840.1.101.3.4.1.42"), octets(iv)),
      ),
    ),
    octets(ciphertext),
  );
};

const tripleDesItem = (plaintext: Buffer) => {
  const entrySalt = Buffer.alloc(20, 5);
  const combined = sha1(sha1(GLOBAL_SALT), entrySalt);
  const hmac = (data: Buffer) => NodeCrypto.createHmac("sha1", combined).update(data).digest();
  const derived = Buffer.concat([
    hmac(Buffer.concat([entrySalt, entrySalt])),
    hmac(Buffer.concat([hmac(entrySalt), entrySalt])),
  ]);
  const ciphertext = encrypt(
    "des-ede3-cbc",
    derived.subarray(0, 24),
    derived.subarray(-8),
    plaintext,
  );
  return sequence(
    sequence(oid("1.2.840.113549.1.12.5.1.3"), sequence(octets(entrySalt), integer(1))),
    octets(ciphertext),
  );
};

const loginField = (value: string, masterKey: Buffer, cipher: "aes" | "3des") => {
  const iv = Buffer.alloc(cipher === "aes" ? 16 : 8, 9);
  const ciphertext =
    cipher === "aes"
      ? encrypt("aes-256-cbc", masterKey.subarray(0, 32), iv, Buffer.from(value))
      : encrypt("des-ede3-cbc", masterKey.subarray(0, 24), iv, Buffer.from(value));
  return sequence(
    octets(CKA_ID),
    sequence(oid(cipher === "aes" ? "2.16.840.1.101.3.4.1.42" : "1.2.840.113549.3.7"), octets(iv)),
    octets(ciphertext),
  ).toString("base64");
};

const writeProfile = Effect.fnUntraced(function* (input: {
  readonly passwordCheck: Buffer;
  readonly masterKey: Buffer;
  readonly logins: ReadonlyArray<{
    readonly hostname: string;
    readonly encryptedUsername: string;
    readonly encryptedPassword: string;
  }>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-logins-" });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`create table metaData (id primary key unique on conflict replace, item1, item2)`;
    yield* sql`create table nssPrivate (id primary key unique on conflict abort, a11, a102)`;
    yield* sql`insert into metaData values ('password', ${GLOBAL_SALT}, ${input.passwordCheck})`;
    yield* sql`insert into nssPrivate values (1, ${input.masterKey}, ${CKA_ID})`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${profile}/key4.db` })));
  yield* fileSystem.writeFileString(
    `${profile}/logins.json`,
    JSON.stringify({ nextId: 1, logins: input.logins }),
  );
  return profile;
});

const PASSWORD_CHECK = Buffer.from("password-check");

describe("readFirefoxPasswords", () => {
  it.effect("decrypts AES and 3DES logins with a PBES2-protected master key", () =>
    Effect.gen(function* () {
      const masterKey = Buffer.alloc(32, 0x2a);
      const profile = yield* writeProfile({
        passwordCheck: pbes2Item(PASSWORD_CHECK),
        masterKey: pbes2Item(masterKey),
        logins: [
          {
            hostname: "https://example.test",
            encryptedUsername: loginField("ada", masterKey, "aes"),
            encryptedPassword: loginField("hunter2", masterKey, "aes"),
          },
          {
            hostname: "http://legacy.test:8080",
            encryptedUsername: loginField("", masterKey, "3des"),
            encryptedPassword: loginField("tr1ple", masterKey, "3des"),
          },
          {
            hostname: "chrome://FirefoxAccounts",
            encryptedUsername: loginField("sync", masterKey, "aes"),
            encryptedPassword: loginField("token", masterKey, "aes"),
          },
        ],
      });

      expect(yield* readFirefoxPasswords(profile)).toEqual([
        { origin: "https://example.test", username: "ada", password: "hunter2" },
        { origin: "http://legacy.test:8080", username: "", password: "tr1ple" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("decrypts a legacy pbeWithSha1AndTripleDES key4.db", () =>
    Effect.gen(function* () {
      const masterKey = Buffer.alloc(24, 0x11);
      const profile = yield* writeProfile({
        passwordCheck: tripleDesItem(PASSWORD_CHECK),
        masterKey: tripleDesItem(masterKey),
        logins: [
          {
            hostname: "https://old.test",
            encryptedUsername: loginField("grace", masterKey, "3des"),
            encryptedPassword: loginField("cobol", masterKey, "3des"),
          },
        ],
      });

      expect(yield* readFirefoxPasswords(profile)).toEqual([
        { origin: "https://old.test", username: "grace", password: "cobol" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails with primaryPasswordSet when the empty password does not unlock key4.db", () =>
    Effect.gen(function* () {
      const masterKey = Buffer.alloc(32, 0x2a);
      const profile = yield* writeProfile({
        passwordCheck: pbes2Item(PASSWORD_CHECK, "primary"),
        masterKey: pbes2Item(masterKey, "primary"),
        logins: [
          {
            hostname: "https://example.test",
            encryptedUsername: loginField("ada", masterKey, "aes"),
            encryptedPassword: loginField("hunter2", masterKey, "aes"),
          },
        ],
      });

      const error = yield* readFirefoxPasswords(profile).pipe(Effect.flip);
      expect(error.reason).toBe("primaryPasswordSet");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
