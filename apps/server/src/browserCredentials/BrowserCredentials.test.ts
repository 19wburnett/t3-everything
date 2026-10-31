import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import type {
  BrowserCredentialError,
  BrowserCredentialId,
  ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BrowserCredentials from "./BrowserCredentials.ts";

const encoder = new TextEncoder();

type Invocation = {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
};
type CliAnswer = { readonly stdout?: string; readonly code?: number } | "missing";

/** Answers `op` and `bw` like their CLIs; a test sees each argv and child env. */
const fakeCli = (answer: (invocation: Invocation) => CliAnswer) => {
  const invocations: Array<Invocation> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const {
        command: binary,
        args,
        options,
      } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: Record<string, string | undefined> };
      };
      const invocation = { binary, args, env: options.env ?? {} };
      invocations.push(invocation);
      const result = answer(invocation);
      if (result === "missing") {
        return Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          ),
        );
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout ?? "")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  return { layer, invocations };
};

const layerFor = (options: {
  readonly stored?: Map<string, Uint8Array>;
  readonly cli?: ReturnType<typeof fakeCli>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) => {
  const stored = options.stored ?? new Map<string, Uint8Array>();
  return BrowserCredentials.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        }),
        ServerSettings.layerTest(options.settings),
        (options.cli ?? fakeCli(() => "missing")).layer,
        NodeCrypto.layer,
      ),
    ),
  );
};

const entry = (origin: string, username: string, password = `${username}-password`) => ({
  origin,
  username,
  password,
});

const reasonOf = <A>(effect: Effect.Effect<A, BrowserCredentialError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("BrowserCredentials", () => {
  it.effect("imports http(s) logins once per site and username, replacing the same source", () => {
    const stored = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const credentials = yield* BrowserCredentials.BrowserCredentials;
      const first = yield* credentials.import({
        sourceName: "Chrome (Default)",
        entries: [
          entry("https://example.com/login", "ada"),
          entry("https://EXAMPLE.com/other", "ada", "duplicate"),
          entry("https://example.com", "grace"),
          entry("android://hash@com.example.app/", "ada"),
          entry("not a url", "ada"),
          entry("https://blank.example", "ada", ""),
        ],
      });
      assert.deepStrictEqual(first, { imported: 2, skipped: 4 });
      yield* credentials.import({
        sourceName: "Firefox",
        entries: [entry("https://example.com", "ada")],
      });
      const before = (yield* credentials.matching("https://example.com/")).filter(
        (credential) => credential.sourceName === "Chrome (Default)",
      );

      yield* credentials.import({
        sourceName: "Chrome (Default)",
        entries: [entry("https://example.com", "ada", "rotated"), entry("http://new.test", "lin")],
      });
      const { credentials: listed } = yield* credentials.list;
      assert.deepStrictEqual(
        listed.map(({ origin, username, sourceName }) => [sourceName, origin, username]),
        [
          ["Firefox", "https://example.com", "ada"],
          ["Chrome (Default)", "https://example.com", "ada"],
          ["Chrome (Default)", "http://new.test", "lin"],
        ],
      );
      assert.notProperty(listed[0], "secret");
      // A re-import keeps a login's id, so an agent's id from preview_status stays valid.
      const ada = listed[1]!;
      assert.strictEqual(ada.id, before.find((credential) => credential.username === "ada")?.id);
      assert.strictEqual(
        yield* credentials.resolveForFill({
          credentialId: ada.id,
          field: "password",
          url: "https://app.example.com/",
        }),
        "rotated",
      );
    }).pipe(
      Effect.provide(layerFor({ stored })),
      // A fresh instance reads what the first one persisted.
      Effect.andThen(
        Effect.gen(function* () {
          const reloaded = yield* BrowserCredentials.BrowserCredentials;
          const matches = yield* reloaded.matching("http://new.test/");
          assert.deepStrictEqual(
            matches.map((credential) => credential.username),
            ["lin"],
          );
        }).pipe(Effect.provide(layerFor({ stored }))),
      ),
    );
  });

  it.effect("removes logins and fills only on the login's site", () =>
    Effect.gen(function* () {
      const credentials = yield* BrowserCredentials.BrowserCredentials;
      yield* credentials.import({
        sourceName: "Chrome",
        entries: [entry("https://example.com", "ada"), entry("https://other.test", "grace")],
      });
      const [ada, grace] = (yield* credentials.list).credentials;
      const fill = (credentialId: BrowserCredentialId, url: string) =>
        credentials.resolveForFill({ credentialId, field: "password", url });

      assert.strictEqual(
        yield* credentials.resolveForFill({
          credentialId: ada!.id,
          field: "username",
          url: "https://example.com/",
        }),
        "ada",
      );
      assert.strictEqual(
        yield* reasonOf(fill(ada!.id, "https://evilexample.com/")),
        "origin_mismatch",
      );
      assert.strictEqual(yield* reasonOf(fill(ada!.id, "http://example.com/")), "origin_mismatch");

      yield* credentials.remove({ credentialIds: [ada!.id] });
      assert.strictEqual(yield* reasonOf(fill(ada!.id, "https://example.com/")), "not_found");
      assert.deepStrictEqual(
        (yield* credentials.list).credentials.map((credential) => credential.id),
        [grace!.id],
      );
    }).pipe(Effect.provide(layerFor({}))),
  );

  it.effect("syncs 1Password logins by reference and reads the password at fill time", () => {
    const cli = fakeCli(({ binary, args }) => {
      if (binary !== "op") return "missing";
      if (args.includes("whoami")) return { stdout: "{}" };
      if (args.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              id: "item1",
              title: "Example",
              vault: { id: "vault1", name: "Private" },
              urls: [
                { href: "https://other.example.com" },
                { href: "https://example.com/login", primary: true },
              ],
              additional_information: "ada@example.com",
            },
            { id: "item2", vault: { id: "vault1", name: "Private" }, urls: [] },
            { id: "item3", vault: { id: "vault1", name: "Private" } },
          ]),
        };
      }
      if (args.includes("read")) return { stdout: "op-secret" };
      return { code: 1 };
    });
    return Effect.gen(function* () {
      const credentials = yield* BrowserCredentials.BrowserCredentials;
      assert.deepStrictEqual(yield* credentials.sync({ manager: "one_password" }), {
        imported: 1,
        skipped: 2,
      });
      const listed = yield* credentials.list;
      assert.deepStrictEqual(listed.managers, {
        one_password: "ready",
        bitwarden: "not_installed",
      });
      const [login] = listed.credentials;
      assert.deepInclude(login, {
        origin: "https://example.com",
        username: "ada@example.com",
        source: "one_password",
        sourceName: "1Password: Private",
      });
      assert.strictEqual(
        yield* credentials.resolveForFill({
          credentialId: login!.id,
          field: "password",
          url: "https://example.com/",
        }),
        "op-secret",
      );
      assert.deepStrictEqual(cli.invocations.at(-1)?.args, [
        "--cache=false",
        "read",
        "--no-newline",
        "op://vault1/item1/password",
        "--account=my.1password.com",
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          cli,
          settings: {
            secretProviders: {
              personal: {
                kind: "one_password",
                label: "1Password",
                config: { account: "my.1password.com" },
              },
            },
          } as Partial<ServerSettingsShape>,
        }),
      ),
    );
  });

  it.effect("reports signed-out and missing password managers", () =>
    Effect.gen(function* () {
      const credentials = yield* BrowserCredentials.BrowserCredentials;
      assert.deepStrictEqual((yield* credentials.list).managers, {
        one_password: "signed_out",
        bitwarden: "signed_out",
      });
      assert.strictEqual(
        yield* reasonOf(credentials.sync({ manager: "one_password" })),
        "manager_signed_out",
      );
    }).pipe(
      Effect.provide(
        layerFor({
          cli: fakeCli(({ binary, args }) =>
            binary === "bw" && args.includes("status")
              ? { stdout: JSON.stringify({ status: "unauthenticated" }) }
              : { code: 1 },
          ),
        }),
      ),
    ),
  );

  it.effect("keeps the Bitwarden master password and session out of argv", () => {
    const cli = fakeCli(({ binary, args, env }) => {
      if (binary !== "bw") return "missing";
      if (args.includes("unlock")) {
        return env.T3_BW_PASSWORD === "master" ? { stdout: "session-key\n" } : { code: 1 };
      }
      const unlocked = env.BW_SESSION === "session-key";
      if (args.includes("status"))
        return { stdout: JSON.stringify({ status: unlocked ? "unlocked" : "locked" }) };
      if (!unlocked) return { code: 1 };
      if (args.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              id: "bw-item-1",
              type: 1,
              login: {
                username: "ada",
                uris: [{ uri: "androidapp://x" }, { uri: "https://example.com/a" }],
              },
            },
            { id: "bw-note", type: 2, login: null },
          ]),
        };
      }
      if (args.includes("get")) return { stdout: "bw-secret\n" };
      return {};
    });
    return Effect.gen(function* () {
      const credentials = yield* BrowserCredentials.BrowserCredentials;
      assert.strictEqual(
        yield* reasonOf(credentials.sync({ manager: "bitwarden" })),
        "manager_locked",
      );
      assert.strictEqual(
        yield* reasonOf(credentials.unlockBitwarden({ masterPassword: "wrong" })),
        "unlock_failed",
      );
      yield* credentials.unlockBitwarden({ masterPassword: "master" });
      assert.strictEqual((yield* credentials.list).managers.bitwarden, "ready");
      assert.deepStrictEqual(yield* credentials.sync({ manager: "bitwarden" }), {
        imported: 1,
        skipped: 1,
      });
      const [login] = (yield* credentials.list).credentials;
      const fill = credentials.resolveForFill({
        credentialId: login!.id,
        field: "password",
        url: "https://example.com/",
      });
      assert.strictEqual(yield* fill, "bw-secret");

      yield* credentials.lockBitwarden;
      assert.strictEqual(yield* reasonOf(fill), "manager_locked");
      for (const { args } of cli.invocations) {
        assert.notInclude(args.join(" "), "master");
        assert.notInclude(args.join(" "), "session-key");
      }
    }).pipe(Effect.provide(layerFor({ cli })));
  });
});
