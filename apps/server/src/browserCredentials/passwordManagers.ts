import type { BrowserCredentialManagerStatus } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { normalizeCredentialOrigin } from "./origin.ts";

export const STATUS_TIMEOUT = Duration.seconds(10);
export const SYNC_TIMEOUT = Duration.seconds(60);
// Long enough to reach for a fingerprint reader when 1Password asks for one.
export const READ_TIMEOUT = Duration.seconds(45);

export type CliOutcome =
  | { readonly _tag: "missing" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "exited"; readonly code: number; readonly stdout: string };

/**
 * Runs a password manager CLI. `env` reaches only this child, which is how secrets go in: never in
 * argv, where other local users can read them.
 */
export const runCli = Effect.fn("BrowserCredentials.runCli")(function* (
  binary: "op" | "bw",
  args: ReadonlyArray<string>,
  timeout: Duration.Duration,
  env?: Readonly<Record<string, string>>,
) {
  yield* Effect.annotateCurrentSpan({ "browser_credentials.cli": binary });
  const spawn = yield* resolveSpawnCommand(binary, args);
  return yield* spawnAndCollect(
    binary,
    ChildProcess.make(spawn.command, spawn.args, {
      shell: spawn.shell,
      ...(env === undefined ? {} : { env: { ...env }, extendEnv: true }),
    }),
  ).pipe(
    Effect.map((result): CliOutcome => ({
      _tag: "exited",
      code: result.code,
      stdout: result.stdout,
    })),
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): CliOutcome => ({ _tag: "timeout" }))),
    Effect.orElseSucceed((): CliOutcome => ({ _tag: "missing" })),
  );
});

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
export const onePasswordArgs = (account: string | undefined, args: ReadonlyArray<string>) => [
  "--cache=false",
  ...args,
  ...(account === undefined ? [] : [`--account=${account}`]),
];

// `--nointeraction` makes `bw` fail instead of waiting on a prompt nobody can answer.
export const bitwardenArgs = (args: ReadonlyArray<string>) => [...args, "--nointeraction"];

export const onePasswordStatus = (outcome: CliOutcome): BrowserCredentialManagerStatus =>
  outcome._tag === "missing"
    ? "not_installed"
    : outcome._tag === "exited" && outcome.code === 0
      ? "ready"
      : "signed_out";

const BitwardenStatusOutput = Schema.fromJsonString(Schema.Struct({ status: Schema.String }));
const decodeBitwardenStatus = Schema.decodeUnknownOption(BitwardenStatusOutput);

/** "ready" needs both an unlocked vault and a session key this server holds. */
export const bitwardenStatus = (
  outcome: CliOutcome,
  hasSession: boolean,
): BrowserCredentialManagerStatus => {
  if (outcome._tag === "missing") return "not_installed";
  if (outcome._tag === "timeout" || outcome.code !== 0) return "locked";
  const status = Option.getOrUndefined(decodeBitwardenStatus(outcome.stdout))?.status;
  if (status === "unauthenticated") return "signed_out";
  return status === "unlocked" && hasSession ? "ready" : "locked";
};

interface ManagerLogin {
  readonly origin: string;
  readonly username: string;
  readonly sourceName: string;
  readonly secret:
    | { readonly type: "one_password"; readonly reference: string }
    | { readonly type: "bitwarden"; readonly itemId: string };
}

// Ids go into argv and `op://` references, so only plain ids pass.
const OnePasswordId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,64}$/));
const BitwardenId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/));

const OnePasswordItem = Schema.Struct({
  id: OnePasswordId,
  vault: Schema.Struct({ id: OnePasswordId, name: Schema.String }),
  urls: Schema.optional(
    Schema.Array(Schema.Struct({ href: Schema.String, primary: Schema.optional(Schema.Boolean) })),
  ),
  additional_information: Schema.optional(Schema.String),
});
const decodeOnePasswordItem = Schema.decodeUnknownOption(OnePasswordItem);

const BitwardenItem = Schema.Struct({
  id: BitwardenId,
  type: Schema.Number,
  login: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        username: Schema.optional(Schema.NullOr(Schema.String)),
        uris: Schema.optional(
          Schema.NullOr(
            Schema.Array(Schema.Struct({ uri: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
        ),
      }),
    ),
  ),
});
const decodeBitwardenItem = Schema.decodeUnknownOption(BitwardenItem);
const BITWARDEN_LOGIN_TYPE = 1;

const decodeJsonArray = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

/** Undefined when the output is not a JSON array; items without a usable URL count as skipped. */
export const parseOnePasswordItems = (stdout: string) =>
  Option.getOrUndefined(decodeJsonArray(stdout))?.map((raw): ManagerLogin | undefined => {
    const item = Option.getOrUndefined(decodeOnePasswordItem(raw));
    const url = item?.urls?.find((entry) => entry.primary === true) ?? item?.urls?.[0];
    const origin = url === undefined ? undefined : normalizeCredentialOrigin(url.href);
    if (item === undefined || origin === undefined) return undefined;
    return {
      origin,
      username: item.additional_information ?? "",
      sourceName: `1Password: ${item.vault.name}`,
      secret: { type: "one_password", reference: `op://${item.vault.id}/${item.id}/password` },
    };
  });

export const parseBitwardenItems = (stdout: string) =>
  Option.getOrUndefined(decodeJsonArray(stdout))?.map((raw): ManagerLogin | undefined => {
    const item = Option.getOrUndefined(decodeBitwardenItem(raw));
    if (item === undefined || item.type !== BITWARDEN_LOGIN_TYPE || !item.login) return undefined;
    const origin = (item.login.uris ?? [])
      .map((entry) => (entry.uri ? normalizeCredentialOrigin(entry.uri) : undefined))
      .find((value) => value !== undefined);
    if (origin === undefined) return undefined;
    return {
      origin,
      username: item.login.username ?? "",
      sourceName: "Bitwarden",
      secret: { type: "bitwarden", itemId: item.id },
    };
  });
