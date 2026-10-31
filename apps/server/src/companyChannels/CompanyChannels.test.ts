import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CompanyChannelAccountId,
  type CompanyChannelAccountSaveInput,
  CompanyDraftId,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CompanyChannels from "./CompanyChannels.ts";
import * as MailTransport from "./MailTransport.ts";

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

const projectId = ProjectId.make("project-1");
const secret = (value: string) => Redacted.make(value);

/** The service over a fake network, a fake mail server, and a real project folder. */
const withChannels = <A, E>(
  options: {
    readonly handle?: (sent: Sent) => Reply;
    readonly mail?: Partial<MailTransport.MailTransport["Service"]>;
  },
  use: (input: {
    readonly channels: CompanyChannels.CompanyChannels["Service"];
    readonly requests: ReadonlyArray<Sent>;
    readonly root: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-company-" });
    const requests: Array<Sent> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const sent: Sent = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        };
        requests.push(sent);
        const reply = options.handle?.(sent) ?? { status: 404, body: {} };
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json", ...reply.headers },
          }),
        );
      }),
    );
    const mail = MailTransport.MailTransport.of({
      verify: () => Effect.void,
      listInbox: () => Effect.succeed([]),
      readMessage: () => Effect.succeed(null),
      send: () => Effect.succeed({ messageId: null }),
      ...options.mail,
    });
    const workspaceFiles = WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void })),
      Layer.provide(WorkspacePaths.layer),
    );
    const layer = CompanyChannels.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(MailTransport.MailTransport, mail),
          Layer.mock(ProjectService.ProjectService)({
            getShell: (id) =>
              Effect.succeed(
                id === projectId
                  ? Option.some({ id, workspaceRoot: root } as OrchestrationProjectShell)
                  : Option.none(),
              ),
          }),
          workspaceFiles,
          WorkspacePaths.layer,
          ServerSecretStore.layer,
        ).pipe(
          Layer.provideMerge(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-company-state-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const channels = yield* CompanyChannels.CompanyChannels;
      return yield* use({ channels, requests, root });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readOutboxFile = (root: string, id: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(`${root}/company/outbox/${id}.md`),
  );

const xAccount: CompanyChannelAccountSaveInput = {
  projectId,
  label: "Company X",
  credentials: {
    _tag: "x",
    consumerKey: secret("ck-value"),
    consumerSecret: secret("cs-value"),
    accessToken: secret("at-value"),
    accessTokenSecret: secret("ats-value"),
  },
};

const xApi =
  (posts: Array<Reply>) =>
  (sent: Sent): Reply =>
    sent.url.pathname === "/2/users/me"
      ? { body: { data: { id: "1", username: "acme" } } }
      : sent.url.pathname === "/2/tweets"
        ? (posts.shift() ?? { status: 500, body: {} })
        : { status: 404, body: {} };

describe("CompanyChannels", () => {
  it.effect("checks X keys on save, keeps them on update, and never lists them", () =>
    withChannels({ handle: xApi([]) }, ({ channels, requests }) =>
      Effect.gen(function* () {
        const saved = yield* channels.saveAccount(xAccount);
        expect(saved).toMatchObject({ kind: "x", address: "@acme", health: { _tag: "ok" } });
        const authorization = requests[0]?.headers["authorization"] ?? "";
        expect(authorization).toMatch(/^OAuth /);
        expect(authorization).toContain('oauth_consumer_key="ck-value"');
        expect(authorization).toContain('oauth_token="at-value"');

        // Secrets are optional on update and the saved ones still sign.
        yield* channels.saveAccount({
          projectId,
          accountId: saved.id,
          label: "Renamed",
          credentials: { _tag: "x" },
        });
        expect(requests[1]?.headers["authorization"]).toContain('oauth_consumer_key="ck-value"');

        const listed = JSON.stringify(yield* channels.listAccounts(projectId));
        expect(listed).toContain("Renamed");
        for (const value of ["ck-value", "cs-value", "at-value", "ats-value"]) {
          expect(listed).not.toContain(value);
        }
      }),
    ),
  );

  it.effect("refuses to save a mail account the server rejects", () =>
    withChannels(
      {
        mail: {
          verify: () =>
            Effect.fail(
              new MailTransport.MailTransportError({
                stage: "imap",
                reason: "auth",
                cause: new Error("AUTHENTICATIONFAILED"),
              }),
            ),
        },
      },
      ({ channels }) =>
        Effect.gen(function* () {
          const error = yield* channels
            .saveAccount({
              projectId,
              label: "Mail",
              credentials: {
                _tag: "imap",
                preset: "gmail",
                address: "team@acme.test",
                password: secret("app-password"),
              },
            })
            .pipe(Effect.flip);
          expect(error.reason).toBe("auth_failed");
          expect(error.message).toContain("app password");
          expect(yield* channels.listAccounts(projectId)).toEqual([]);
        }),
    ),
  );

  it.effect("sends a draft once, records failures, and lists malformed files", () => {
    const posts: Array<Reply> = [
      { status: 201, body: { data: { id: "99" } } },
      { status: 403, body: { title: "Forbidden", detail: "You are not permitted." } },
    ];
    return withChannels({ handle: xApi(posts) }, ({ channels, requests, root }) =>
      Effect.gen(function* () {
        const account = yield* channels.saveAccount(xAccount);
        const draft = yield* channels.saveDraft({
          projectId,
          createdBy: "Muse",
          draft: { channel: "x", accountId: account.id, text: "Launch day!" },
        });
        expect(draft).toMatchObject({ status: "draft", createdBy: "Muse" });
        expect(draft.path).toBe(`company/outbox/${draft.id}.md`);
        expect(draft.id).toMatch(/^1970-01-01-launch-day-[0-9a-f]{6}$/);

        const sent = yield* channels.send({ projectId, draftId: draft.id });
        expect(sent).toMatchObject({ status: "sent", url: "https://x.com/acme/status/99" });
        const tweet = requests.find((sent) => sent.url.pathname === "/2/tweets");
        expect(JSON.parse(tweet?.body ?? "")).toEqual({ text: "Launch day!" });
        const file = yield* readOutboxFile(root, draft.id);
        expect(file).toContain('status: "sent"');
        expect(file).toContain('url: "https://x.com/acme/status/99"');

        const again = yield* channels.send({ projectId, draftId: draft.id }).pipe(Effect.flip);
        expect(again.reason).toBe("not_sendable");
        const discard = yield* channels
          .discardDraft({ projectId, draftId: draft.id })
          .pipe(Effect.flip);
        expect(discard.reason).toBe("not_sendable");

        const refused = yield* channels.saveDraft({
          projectId,
          draft: { channel: "x", accountId: account.id, text: "Second" },
        });
        const failed = yield* channels.send({ projectId, draftId: refused.id });
        expect(failed.status).toBe("failed");
        expect(failed.error).toContain("You are not permitted.");
        expect(yield* readOutboxFile(root, refused.id)).toContain('status: "failed"');
        // A refused credential shows on the account until it works again.
        expect((yield* channels.listAccounts(projectId))[0]?.health._tag).toBe("error");

        const long = yield* channels.saveDraft({
          projectId,
          draft: { channel: "x", accountId: account.id, text: "x".repeat(281) },
        });
        const tooLong = yield* channels.send({ projectId, draftId: long.id }).pipe(Effect.flip);
        expect(tooLong).toMatchObject({ reason: "too_long" });
        expect(tooLong.message).toContain("281");
        expect(yield* readOutboxFile(root, long.id)).toContain('status: "draft"');

        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          `${root}/company/outbox/1970-01-02-bad.md`,
          "no frontmatter",
        );
        yield* fileSystem.writeFileString(`${root}/company/outbox/Notes.md`, "---\n---\n");
        const outbox = yield* channels.listOutbox(projectId);
        expect(outbox.drafts.map((entry) => entry.id).toSorted()).toEqual(
          [draft.id, refused.id, long.id].toSorted(),
        );
        expect(outbox.malformed.map((entry) => entry.path).toSorted()).toEqual([
          "company/outbox/1970-01-02-bad.md",
          "company/outbox/Notes.md",
        ]);

        expect(yield* channels.discardDraft({ projectId, draftId: refused.id })).toBe(true);
        expect(
          yield* channels.discardDraft({ projectId, draftId: CompanyDraftId.make("gone") }),
        ).toBe(false);
      }),
    );
  });

  it.effect("posts to LinkedIn as the member and links the post", () =>
    withChannels(
      {
        handle: (sent) =>
          sent.url.pathname === "/v2/userinfo"
            ? { body: { sub: "abc", name: "Ada" } }
            : sent.url.pathname === "/rest/posts"
              ? { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }
              : { status: 404, body: {} },
      },
      ({ channels, requests }) =>
        Effect.gen(function* () {
          const account = yield* channels.saveAccount({
            projectId,
            label: "LinkedIn",
            credentials: {
              _tag: "linkedin",
              accessToken: secret("li-token"),
              tokenExpiresAt: DateTime.makeUnsafe(3 * 86_400_000),
            },
          });
          expect(account.health).toEqual({ _tag: "expiring", expiresInDays: 3 });
          const draft = yield* channels.saveDraft({
            projectId,
            draft: { channel: "linkedin", accountId: account.id, text: "Hello network" },
          });
          const sent = yield* channels.send({ projectId, draftId: draft.id });
          expect(sent.url).toBe("https://www.linkedin.com/feed/update/urn:li:share:7");
          const post = requests.find((sent) => sent.url.pathname === "/rest/posts");
          expect(post?.headers["authorization"]).toBe("Bearer li-token");
          expect(post?.headers["linkedin-version"]).toMatch(/^\d{6}$/);
          expect(post?.headers["x-restli-protocol-version"]).toBe("2.0.0");
          expect(JSON.parse(post?.body ?? "")).toMatchObject({
            author: "urn:li:person:abc",
            commentary: "Hello network",
            visibility: "PUBLIC",
            lifecycleState: "PUBLISHED",
          });
        }),
    ),
  );

  it.effect("refreshes a week-old Threads token before publishing with it", () =>
    withChannels(
      {
        handle: (sent) => {
          const path = sent.url.pathname;
          if (path === "/v1.0/me") return { body: { id: "42", username: "acme" } };
          if (path === "/refresh_access_token") {
            return {
              body: { access_token: "th-new", token_type: "bearer", expires_in: 5_184_000 },
            };
          }
          if (path === "/v1.0/42/threads") return { body: { id: "container-1" } };
          if (path === "/v1.0/42/threads_publish") return { body: { id: "media-1" } };
          if (path === "/v1.0/media-1") {
            return { body: { id: "media-1", permalink: "https://www.threads.net/@acme/post/x" } };
          }
          return { status: 404, body: {} };
        },
      },
      ({ channels, requests }) =>
        Effect.gen(function* () {
          const account = yield* channels.saveAccount({
            projectId,
            label: "Threads",
            credentials: { _tag: "threads", accessToken: secret("th-old") },
          });
          expect(account).toMatchObject({ address: "@acme", connection: { userId: "42" } });
          yield* TestClock.adjust("8 days");
          const draft = yield* channels.saveDraft({
            projectId,
            draft: { channel: "threads", accountId: account.id, text: "Hi Threads" },
          });
          const sent = yield* channels.send({ projectId, draftId: draft.id });
          expect(sent.url).toBe("https://www.threads.net/@acme/post/x");
          const paths = requests.map((sent) => sent.url.pathname);
          expect(paths.slice(1)).toEqual([
            "/refresh_access_token",
            "/v1.0/42/threads",
            "/v1.0/42/threads_publish",
            "/v1.0/media-1",
          ]);
          expect(requests[1]?.url.searchParams.get("access_token")).toBe("th-old");
          const publish = requests[2]?.url.searchParams;
          expect(publish?.get("access_token")).toBe("th-new");
          expect(publish?.get("media_type")).toBe("TEXT");
          expect(publish?.get("text")).toBe("Hi Threads");
          const [listed] = yield* channels.listAccounts(projectId);
          expect(listed?.tokenExpiresAt).toEqual(
            DateTime.makeUnsafe(8 * 86_400_000 + 5_184_000_000),
          );
        }),
    ),
  );

  it.effect("signs in to Microsoft with a device code and reads the inbox through Graph", () => {
    const polls: Array<Reply> = [
      { status: 400, body: { error: "authorization_pending" } },
      {
        body: { access_token: "ms-access", refresh_token: "ms-refresh", expires_in: 3600 },
      },
    ];
    return withChannels(
      {
        handle: (sent) => {
          const path = sent.url.pathname;
          if (path === "/contoso/oauth2/v2.0/devicecode") {
            return {
              body: {
                device_code: "device-1",
                user_code: "ABCD-1234",
                verification_uri: "https://microsoft.com/devicelogin",
                expires_in: 900,
                interval: 5,
              },
            };
          }
          if (path === "/contoso/oauth2/v2.0/token") return polls.shift() ?? { status: 500 };
          if (path === "/v1.0/me") return { body: { mail: "team@contoso.test" } };
          if (path === "/v1.0/me/mailFolders/inbox/messages") {
            return {
              body: {
                value: [
                  {
                    id: "AAMk-1",
                    subject: "Quote",
                    from: { emailAddress: { name: "Bob", address: "bob@x.test" } },
                    toRecipients: [{ emailAddress: { address: "team@contoso.test" } }],
                    receivedDateTime: "2026-10-30T12:00:00Z",
                    bodyPreview: "Can you send a quote?",
                    isRead: false,
                  },
                ],
              },
            };
          }
          return { status: 404, body: {} };
        },
      },
      ({ channels, requests }) =>
        Effect.gen(function* () {
          const prompt = yield* channels.microsoftSignInStart({
            projectId,
            label: "Outlook",
            clientId: "client-1",
            tenant: "contoso",
          });
          expect(prompt).toEqual({
            userCode: "ABCD-1234",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresAt: DateTime.makeUnsafe(900_000),
          });
          expect(new URLSearchParams(requests[0]?.body).get("scope")).toBe(
            "offline_access Mail.ReadWrite Mail.Send User.Read",
          );
          const waiting = yield* Effect.forkChild(channels.microsoftSignInWait(projectId));
          yield* TestClock.adjust("10 seconds");
          const account = yield* Fiber.join(waiting);
          expect(account).toMatchObject({
            kind: "email",
            address: "team@contoso.test",
            connection: { _tag: "microsoft", tenant: "contoso", clientId: "client-1" },
          });
          const polled = requests.filter((sent) => sent.url.pathname.endsWith("/token"));
          expect(polled).toHaveLength(2);
          expect(new URLSearchParams(polled[0]?.body).get("device_code")).toBe("device-1");

          const inbox = yield* channels.listInbox({ projectId, accountId: account.id, limit: 10 });
          expect(inbox.messages).toEqual([
            {
              id: "AAMk-1",
              from: "Bob <bob@x.test>",
              to: ["team@contoso.test"],
              subject: "Quote",
              date: DateTime.makeUnsafe("2026-10-30T12:00:00Z"),
              snippet: "Can you send a quote?",
              unread: true,
            },
          ]);
          const list = requests.at(-1);
          expect(list?.headers["authorization"]).toBe("Bearer ms-access");
          expect(list?.url.searchParams.get("$top")).toBe("10");
          expect(list?.url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
        }),
    );
  });

  it.effect("drafts IMAP replies threaded to the original and sends them over SMTP", () => {
    const sends: Array<{ mail: MailTransport.OutgoingMail; appendToSent: boolean }> = [];
    return withChannels(
      {
        mail: {
          readMessage: (_login, uid) =>
            Effect.succeed(
              uid === "12"
                ? {
                    uid: "12",
                    from: "Bob <bob@x.test>",
                    to: ["team@acme.test"],
                    cc: [],
                    subject: "Hello",
                    date: null,
                    snippet: "",
                    unread: true,
                    text: "Hi there",
                    messageId: "<m1@x.test>",
                    references: ["<m0@x.test>"],
                  }
                : null,
            ),
          send: (_login, mail, options) =>
            Effect.sync(() => {
              sends.push({ mail, appendToSent: options.appendToSent });
              return { messageId: "<sent@acme.test>" };
            }),
        },
      },
      ({ channels }) =>
        Effect.gen(function* () {
          const account = yield* channels.saveAccount({
            projectId,
            label: "Mail",
            credentials: {
              _tag: "imap",
              preset: "fastmail",
              address: "team@acme.test",
              password: secret("app-password"),
            },
          });
          const draft = yield* channels.saveDraft({
            projectId,
            draft: {
              channel: "email",
              accountId: account.id,
              text: "Thanks!",
              replyToMessageId: "12",
            },
          });
          expect(draft).toMatchObject({
            to: ["bob@x.test"],
            subject: "Re: Hello",
            inReplyTo: "<m1@x.test>",
            references: ["<m0@x.test>", "<m1@x.test>"],
          });
          expect((yield* channels.send({ projectId, draftId: draft.id })).status).toBe("sent");
          expect(sends).toEqual([
            {
              mail: {
                from: "team@acme.test",
                to: ["bob@x.test"],
                cc: [],
                subject: "Re: Hello",
                text: "Thanks!",
                inReplyTo: "<m1@x.test>",
                references: ["<m0@x.test>", "<m1@x.test>"],
              },
              appendToSent: true,
            },
          ]);

          const missing = yield* channels
            .readMessage({ projectId, accountId: account.id, messageId: "13" })
            .pipe(Effect.flip);
          expect(missing.reason).toBe("unknown_message");
          const elsewhere = yield* channels
            .listInbox({ projectId, accountId: CompanyChannelAccountId.make("acct-other") })
            .pipe(Effect.flip);
          expect(elsewhere.reason).toBe("unknown_account");
        }),
    );
  });
});
