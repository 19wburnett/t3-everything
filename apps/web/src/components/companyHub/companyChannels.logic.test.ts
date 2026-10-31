import {
  type CompanyChannelAccount,
  CompanyChannelAccountId,
  CompanyChannelError,
  ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  accountFormFrom,
  buildAccountCredentials,
  channelFailure,
  describeHealth,
  emptyAccountForm,
  parseAddressList,
  pickEmailAccount,
  postLength,
} from "./companyChannels.logic";

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z");

const account = (
  id: string,
  overrides: Partial<CompanyChannelAccount> = {},
): CompanyChannelAccount => ({
  id: CompanyChannelAccountId.make(id),
  projectId: ProjectId.make("project"),
  kind: "email",
  label: id,
  address: `${id}@example.com`,
  connection: {
    _tag: "imap",
    preset: "gmail",
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    username: `${id}@example.com`,
  },
  createdAt: now,
  tokenExpiresAt: null,
  health: { _tag: "ok" },
  ...overrides,
});

const revealAll = (value: unknown): unknown =>
  Redacted.isRedacted(value)
    ? `secret:${String(Redacted.value(value))}`
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, revealAll(field)]))
      : value;

describe("postLength", () => {
  it("counts code points of the trimmed post against the network's limit", () => {
    expect(postLength("x", "  hi 👋🏽 \n")).toEqual({ length: 5, limit: 280 });
    expect(postLength("threads", "a")?.limit).toBe(500);
    expect(postLength("linkedin", "a")?.limit).toBe(3000);
    expect(postLength("email", "a")).toBeNull();
  });
});

describe("describeHealth", () => {
  it("labels each problem and asks to reconnect only when the account no longer works", () => {
    expect(describeHealth({ _tag: "ok" })).toBeNull();
    expect(describeHealth({ _tag: "error", message: "Wrong password" })).toEqual({
      tone: "error",
      text: "Wrong password",
      reconnect: true,
    });
    expect(describeHealth({ _tag: "expiring", expiresInDays: 1 })?.text).toBe("Expires in 1 day");
    expect(describeHealth({ _tag: "expiring", expiresInDays: 6 })).toEqual({
      tone: "warning",
      text: "Expires in 6 days",
      reconnect: false,
    });
    expect(describeHealth({ _tag: "expiring", expiresInDays: 0 })?.text).toBe("Expires today");
    expect(describeHealth({ _tag: "expired" })?.reconnect).toBe(true);
  });
});

describe("pickEmailAccount", () => {
  it("keeps the picked inbox, else prefers a working email account", () => {
    const broken = account("broken", { health: { _tag: "error", message: "x" } });
    const working = account("working");
    const social = account("social", { kind: "x", connection: { _tag: "x" } });
    const accounts = [social, broken, working];
    expect(pickEmailAccount(accounts, null)?.id).toBe("working");
    expect(pickEmailAccount(accounts, "broken")?.id).toBe("broken");
    expect(pickEmailAccount(accounts, "social")?.id).toBe("working");
    expect(pickEmailAccount(accounts, "removed")?.id).toBe("working");
    expect(pickEmailAccount([social, broken], null)?.id).toBe("broken");
    expect(pickEmailAccount([social], null)).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("splits on commas, semicolons, and new lines and drops blanks", () => {
    expect(parseAddressList(" a@x.com, b@y.com;\nc@z.com ,, ")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });
});

describe("buildAccountCredentials", () => {
  it("requires secrets when adding and leaves blank ones out when editing, which keeps them", () => {
    const blank = emptyAccountForm("x", now);
    expect(buildAccountCredentials(blank, false)).toEqual({
      missing: ["API key", "API key secret", "access token", "access token secret"],
    });
    expect(buildAccountCredentials(blank, true)).toEqual({ credentials: { _tag: "x" } });
    expect(revealAll(buildAccountCredentials({ ...blank, accessToken: " new " }, true))).toEqual({
      credentials: { _tag: "x", accessToken: "secret:new" },
    });
  });

  it("sends servers only for other IMAP and defaults the username to the address", () => {
    const gmail = { ...emptyAccountForm("gmail", now), address: "me@x.com", password: "pw" };
    expect(revealAll(buildAccountCredentials(gmail, false))).toEqual({
      credentials: { _tag: "imap", preset: "gmail", address: "me@x.com", password: "secret:pw" },
    });

    const custom = { ...emptyAccountForm("imap", now), address: "me@x.com", password: "pw" };
    expect(buildAccountCredentials(custom, false)).toEqual({
      missing: ["IMAP server and port", "SMTP server and port"],
    });
    const filled = {
      ...custom,
      username: "me",
      imap: { host: "imap.x.com", port: "993", security: "tls" as const },
      smtp: { host: "smtp.x.com", port: "587", security: "starttls" as const },
    };
    expect(revealAll(buildAccountCredentials(filled, false))).toEqual({
      credentials: {
        _tag: "imap",
        preset: "custom",
        address: "me@x.com",
        username: "me",
        password: "secret:pw",
        imap: { host: "imap.x.com", port: 993, security: "tls" },
        smtp: { host: "smtp.x.com", port: 587, security: "starttls" },
      },
    });
    expect(
      buildAccountCredentials({ ...filled, smtp: { ...filled.smtp, port: "70000" } }, false),
    ).toEqual({ missing: ["SMTP server and port"] });
  });

  it("round-trips a saved account's form without its secrets", () => {
    const saved = account("sales", {
      connection: {
        _tag: "imap",
        preset: "custom",
        imap: { host: "imap.x.com", port: 993, security: "tls" },
        smtp: { host: "smtp.x.com", port: 587, security: "starttls" },
        username: "sales",
      },
    });
    expect(buildAccountCredentials(accountFormFrom(saved, now), true)).toEqual({
      credentials: {
        _tag: "imap",
        preset: "custom",
        address: "sales@example.com",
        username: "sales",
        imap: { host: "imap.x.com", port: 993, security: "tls" },
        smtp: { host: "smtp.x.com", port: 587, security: "starttls" },
      },
    });
  });

  it("defaults a new social token to 60 days and sends a cleared expiry as unknown", () => {
    const form = { ...emptyAccountForm("linkedin", now), accessToken: "tok" };
    expect(form.tokenExpiresOn).toBe("2026-12-30");
    const built = buildAccountCredentials(form, false);
    expect(
      "credentials" in built && built.credentials._tag === "linkedin"
        ? built.credentials.tokenExpiresAt
        : undefined,
    ).toEqual(DateTime.makeUnsafe("2026-12-30T00:00:00Z"));
    expect(buildAccountCredentials({ ...form, accessToken: "", tokenExpiresOn: "" }, true)).toEqual(
      {
        credentials: { _tag: "linkedin", tokenExpiresAt: null },
      },
    );
  });
});

describe("channelFailure", () => {
  it("keeps the channel reason so callers can point at the failing account", () => {
    expect(
      channelFailure(
        Cause.fail(new CompanyChannelError({ reason: "auth_failed", message: "Signed out" })),
      ),
    ).toEqual({ reason: "auth_failed", message: "Signed out" });
    expect(channelFailure(Cause.fail(new Error("Offline")))).toEqual({
      reason: null,
      message: "Offline",
    });
  });
});
