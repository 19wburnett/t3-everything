// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// NSS PBE and login ciphers Firefox uses; Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { snapshotCookieDatabase } from "./CookieDatabase.ts";
import { BrowserPasswordReadError, toImportEntries } from "./Passwords.ts";

const DER_INTEGER = 0x02;
const DER_OCTET_STRING = 0x04;
const DER_OID = 0x06;
const DER_SEQUENCE = 0x30;

const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_PBE_SHA1_3DES = "1.2.840.113549.1.12.5.1.3";
const OID_AES256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_DES_EDE3_CBC = "1.2.840.113549.3.7";
const PBKDF2_DIGESTS: Readonly<Record<string, string>> = {
  "1.2.840.113549.2.7": "sha1",
  "1.2.840.113549.2.9": "sha256",
};

const PASSWORD_CHECK = Buffer.from("password-check\x02\x02", "latin1");

interface DerNode {
  readonly tag: number;
  readonly value: Buffer;
  readonly children: ReadonlyArray<DerNode>;
}

const readDerNode = (buffer: Buffer, offset: number): [DerNode, number] => {
  if (offset + 2 > buffer.length) throw new Error("Truncated DER");
  const tag = buffer[offset]!;
  let length = buffer[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || start + lengthBytes > buffer.length) {
      throw new Error("Unsupported DER length");
    }
    length = buffer.readUIntBE(start, lengthBytes);
    start += lengthBytes;
  }
  const end = start + length;
  if (end > buffer.length) throw new Error("Truncated DER");
  const value = buffer.subarray(start, end);
  const children: DerNode[] = [];
  if (tag & 0x20) {
    let cursor = 0;
    while (cursor < value.length) {
      const [child, next] = readDerNode(value, cursor);
      children.push(child);
      cursor = next;
    }
  }
  return [{ tag, value, children }, end];
};

const parseDer = (buffer: Buffer): DerNode => readDerNode(buffer, 0)[0];

const derChild = (node: DerNode, index: number, tag: number): DerNode => {
  const child = node.children[index];
  if (child?.tag !== tag) throw new Error("Unexpected DER structure");
  return child;
};

const derOid = (node: DerNode): string => {
  const [first = 0] = node.value;
  const parts = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (const byte of node.value.subarray(1)) {
    current = current * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  return parts.join(".");
};

const derInteger = (node: DerNode): number => {
  if (node.value.length === 0 || node.value.length > 6) throw new Error("Unsupported integer");
  return node.value.readUIntBE(0, node.value.length);
};

const decipher = (
  algorithm: string,
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  unpad: boolean,
) => {
  const instance = NodeCrypto.createDecipheriv(algorithm, key, iv);
  instance.setAutoPadding(unpad);
  return Buffer.concat([instance.update(ciphertext), instance.final()]);
};

const sha1 = (...parts: ReadonlyArray<Buffer>) =>
  NodeCrypto.createHash("sha1").update(Buffer.concat(parts)).digest();

/** NSS's PKCS#12-style derivation for pbeWithSha1AndTripleDES-CBC. */
const decryptSha1TripleDes = (passwordHash: Buffer, params: DerNode, ciphertext: Buffer) => {
  const entrySalt = derChild(params, 0, DER_OCTET_STRING).value;
  const paddedSalt = Buffer.concat([entrySalt, Buffer.alloc(Math.max(0, 20 - entrySalt.length))]);
  const combined = sha1(passwordHash, entrySalt);
  const hmac = (data: Buffer) => NodeCrypto.createHmac("sha1", combined).update(data).digest();
  const k1 = hmac(Buffer.concat([paddedSalt, entrySalt]));
  const k2 = hmac(Buffer.concat([hmac(paddedSalt), entrySalt]));
  const derived = Buffer.concat([k1, k2]);
  return decipher("des-ede3-cbc", derived.subarray(0, 24), derived.subarray(-8), ciphertext, false);
};

const decryptPbes2 = (passwordHash: Buffer, params: DerNode, ciphertext: Buffer) => {
  const kdf = derChild(params, 0, DER_SEQUENCE);
  if (derOid(derChild(kdf, 0, DER_OID)) !== OID_PBKDF2) throw new Error("Unsupported KDF");
  const kdfParams = derChild(kdf, 1, DER_SEQUENCE);
  const salt = derChild(kdfParams, 0, DER_OCTET_STRING).value;
  const iterations = derInteger(derChild(kdfParams, 1, DER_INTEGER));
  let keyLength = 32;
  let digest = "sha1";
  for (const option of kdfParams.children.slice(2)) {
    if (option.tag === DER_INTEGER) keyLength = derInteger(option);
    if (option.tag === DER_SEQUENCE) {
      const prf = PBKDF2_DIGESTS[derOid(derChild(option, 0, DER_OID))];
      if (prf === undefined) throw new Error("Unsupported PRF");
      digest = prf;
    }
  }
  const cipher = derChild(params, 1, DER_SEQUENCE);
  if (derOid(derChild(cipher, 0, DER_OID)) !== OID_AES256_CBC)
    throw new Error("Unsupported cipher");
  const storedIv = derChild(cipher, 1, DER_OCTET_STRING).value;
  // NSS uses the IV's whole DER encoding (tag and length included) as the 16-byte IV.
  const iv =
    storedIv.length === 14 ? Buffer.concat([Buffer.from([0x04, 0x0e]), storedIv]) : storedIv;
  const key = NodeCrypto.pbkdf2Sync(passwordHash, salt, iterations, keyLength, digest);
  return decipher("aes-256-cbc", key, iv, ciphertext, false);
};

/** Decrypts a key4.db item without removing padding. Firefox's password is empty unless a primary password is set. */
const decryptKey4Item = (encoded: Uint8Array, globalSalt: Uint8Array): Buffer => {
  const root = parseDer(Buffer.from(encoded));
  const algorithm = derChild(root, 0, DER_SEQUENCE);
  const params = derChild(algorithm, 1, DER_SEQUENCE);
  const ciphertext = derChild(root, 1, DER_OCTET_STRING).value;
  const passwordHash = sha1(Buffer.from(globalSalt));
  const id = derOid(derChild(algorithm, 0, DER_OID));
  if (id === OID_PBES2) return decryptPbes2(passwordHash, params, ciphertext);
  if (id === OID_PBE_SHA1_3DES) return decryptSha1TripleDes(passwordHash, params, ciphertext);
  throw new Error("Unsupported key4.db algorithm");
};

const stripPkcs7 = (plaintext: Buffer): Buffer => {
  const padding = plaintext.at(-1) ?? 0;
  if (padding < 1 || padding > 16 || padding > plaintext.length) return plaintext;
  const tail = plaintext.subarray(plaintext.length - padding);
  return tail.every((byte) => byte === padding)
    ? plaintext.subarray(0, plaintext.length - padding)
    : plaintext;
};

const decryptMasterKey = (a11: Uint8Array, globalSalt: Uint8Array): Buffer | undefined => {
  try {
    const key = stripPkcs7(decryptKey4Item(a11, globalSalt));
    return key.length >= 24 ? key : undefined;
  } catch {
    return undefined;
  }
};

interface MasterKeys {
  readonly byId: ReadonlyMap<string, Buffer>;
  readonly fallback: Buffer | undefined;
}

/** logins.json fields are base64 DER: SEQUENCE { keyId, SEQUENCE { cipher OID, iv }, ciphertext }. */
const decryptLoginField = (encoded: string, keys: MasterKeys): string | null => {
  try {
    const root = parseDer(Buffer.from(encoded, "base64"));
    const keyId = derChild(root, 0, DER_OCTET_STRING).value.toString("hex");
    const algorithm = derChild(root, 1, DER_SEQUENCE);
    const iv = derChild(algorithm, 1, DER_OCTET_STRING).value;
    const ciphertext = derChild(root, 2, DER_OCTET_STRING).value;
    const key = keys.byId.get(keyId) ?? keys.fallback;
    if (key === undefined) return null;
    const id = derOid(derChild(algorithm, 0, DER_OID));
    if (id === OID_DES_EDE3_CBC) {
      return decipher("des-ede3-cbc", key.subarray(0, 24), iv, ciphertext, true).toString("utf8");
    }
    if (id === OID_AES256_CBC) {
      return decipher("aes-256-cbc", key.subarray(0, 32), iv, ciphertext, true).toString("utf8");
    }
    return null;
  } catch {
    return null;
  }
};

const LoginEntry = Schema.Struct({
  hostname: Schema.String,
  encryptedUsername: Schema.String,
  encryptedPassword: Schema.String,
});
const isLoginEntry = Schema.is(LoginEntry);
const decodeLoginsFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ logins: Schema.optional(Schema.Array(Schema.Unknown)) })),
);

const Key4Rows = Schema.Struct({
  password: Schema.Array(Schema.Struct({ item1: Schema.Uint8Array, item2: Schema.Uint8Array })),
  privateKeys: Schema.Array(
    Schema.Struct({
      a11: Schema.NullOr(Schema.Uint8Array),
      a102: Schema.NullOr(Schema.Uint8Array),
    }),
  ),
});
const decodeKey4Rows = Schema.decodeUnknownEffect(Key4Rows);

const readFailed = (cause?: unknown) =>
  new BrowserPasswordReadError({ reason: "readFailed", ...(cause === undefined ? {} : { cause }) });

const readKey4 = Effect.fn("FirefoxPasswords.readKey4")(function* (snapshotPath: string) {
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      password: yield* sql`select item1, item2 from metaData where id = 'password'`,
      privateKeys: yield* sql`select a11, a102 from nssPrivate`,
    };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })),
    Effect.mapError(readFailed),
  );
  const { password, privateKeys } = yield* decodeKey4Rows(rows).pipe(
    Effect.mapError(() => readFailed()),
  );
  const [meta] = password;
  if (meta === undefined) return yield* readFailed();

  const check = yield* Effect.try({
    try: () => decryptKey4Item(meta.item2, meta.item1),
    catch: () => readFailed(),
  });
  if (!check.equals(PASSWORD_CHECK)) {
    return yield* new BrowserPasswordReadError({ reason: "primaryPasswordSet" });
  }

  const byId = new Map<string, Buffer>();
  let fallback: Buffer | undefined;
  for (const row of privateKeys) {
    const key = row.a11 === null ? undefined : decryptMasterKey(row.a11, meta.item1);
    if (key === undefined) continue;
    fallback ??= key;
    if (row.a102 !== null) byId.set(Buffer.from(row.a102).toString("hex"), key);
  }
  return { byId, fallback } satisfies MasterKeys;
});

/** Reads logins.json with key4.db's master key; Firefox profiles from before key4.db (key3.db) are unsupported. */
export const readFirefoxPasswords = Effect.fn("FirefoxPasswords.readFirefoxPasswords")(function* (
  profilePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const loginsPath = path.join(profilePath, "logins.json");
  if (!(yield* fileSystem.exists(loginsPath).pipe(Effect.orElseSucceed(() => false)))) return [];
  const contents = yield* fileSystem.readFileString(loginsPath).pipe(Effect.mapError(readFailed));
  const logins = (yield* decodeLoginsFile(contents).pipe(
    Effect.mapError(() => readFailed()),
  )).logins?.filter(isLoginEntry);
  if (logins === undefined || logins.length === 0) return [];

  const key4Path = yield* snapshotCookieDatabase(
    path.join(profilePath, "key4.db"),
    "t3code-password-import-",
  ).pipe(Effect.mapError(readFailed));
  const keys = yield* readKey4(key4Path);
  return toImportEntries(
    logins.map((login) => ({
      url: login.hostname,
      username: decryptLoginField(login.encryptedUsername, keys),
      password: decryptLoginField(login.encryptedPassword, keys),
    })),
  );
});
