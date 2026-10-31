import type { CompanyMailServer } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface MailLogin {
  readonly imap: CompanyMailServer;
  readonly smtp: CompanyMailServer;
  readonly username: string;
  readonly password: string;
}

export interface MailSummary {
  readonly uid: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly date: Date | string | null;
  readonly snippet: string;
  readonly unread: boolean;
}

export interface MailMessage extends MailSummary {
  readonly cc: ReadonlyArray<string>;
  readonly text: string;
  readonly messageId: string | null;
  readonly references: ReadonlyArray<string>;
}

export interface OutgoingMail {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: ReadonlyArray<string> | undefined;
}

export const MailTransportStage = Schema.Literals(["imap", "smtp", "append-sent"]);

export class MailTransportError extends Schema.TaggedError<MailTransportError>()(
  "MailTransportError",
  {
    stage: MailTransportStage,
    reason: Schema.Literals(["auth", "unreachable", "failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const server = this.stage === "smtp" ? "SMTP" : "IMAP";
    switch (this.reason) {
      case "auth":
        return `The ${server} server refused the username or app password.`;
      case "unreachable":
        return `Could not reach the ${server} server. Check its host, port, and security.`;
      case "failed":
        return this.stage === "append-sent"
          ? "Sent, but could not save a copy to the Sent folder."
          : `The ${server} server could not complete the request.`;
    }
  }
}

/** IMAP and SMTP behind one small port, so mail logic is tested without a mail server. */
export class MailTransport extends Context.Service<
  MailTransport,
  {
    /** Logs in to IMAP and SMTP without changing anything. */
    readonly verify: (login: MailLogin) => Effect.Effect<void, MailTransportError>;
    /** INBOX, newest first. */
    readonly listInbox: (
      login: MailLogin,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MailSummary>, MailTransportError>;
    readonly readMessage: (
      login: MailLogin,
      uid: string,
    ) => Effect.Effect<MailMessage | null, MailTransportError>;
    /** Sends, then files a copy in the Sent folder when `appendToSent`. */
    readonly send: (
      login: MailLogin,
      mail: OutgoingMail,
      options: { readonly appendToSent: boolean },
    ) => Effect.Effect<{ readonly messageId: string | null }, MailTransportError>;
  }
>()("t3/companyChannels/MailTransport") {}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ESOCKET",
  "ECONNECTION",
  "ETLS",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

const reasonOf = (cause: unknown): "auth" | "unreachable" | "failed" => {
  if (typeof cause !== "object" || cause === null) return "failed";
  const error = cause as {
    readonly code?: unknown;
    readonly authenticationFailed?: unknown;
    readonly responseCode?: unknown;
  };
  if (error.authenticationFailed === true || error.code === "EAUTH" || error.responseCode === 535) {
    return "auth";
  }
  return typeof error.code === "string" && NETWORK_CODES.has(error.code) ? "unreachable" : "failed";
};

const TIMEOUT_MS = 30_000;
const SNIPPET_LENGTH = 200;
const SNIPPET_SOURCE_BYTES = 16_384;

const formatAddress = (address: {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
}) => (address.name ? `${address.name} <${address.address ?? ""}>` : (address.address ?? ""));

const addressList = (
  value:
    | { readonly value: ReadonlyArray<{ readonly name?: string; readonly address?: string }> }
    | ReadonlyArray<{
        readonly value: ReadonlyArray<{ readonly name?: string; readonly address?: string }>;
      }>
    | undefined,
): ReadonlyArray<string> =>
  value === undefined
    ? []
    : (Array.isArray(value) ? value : [value]).flatMap(
        (group: { readonly value: ReadonlyArray<{ name?: string; address?: string }> }) =>
          group.value.map(formatAddress),
      );

const snippetOf = (text: string | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);

const smtpTransport = async (login: MailLogin) => {
  const nodemailer = await import("nodemailer");
  return nodemailer.createTransport({
    host: login.smtp.host,
    port: login.smtp.port,
    secure: login.smtp.security === "tls",
    requireTLS: login.smtp.security === "starttls",
    auth: { user: login.username, pass: login.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
};

type ImapClient = InstanceType<typeof import("imapflow").ImapFlow>;

const withImap = <A>(
  login: MailLogin,
  stage: typeof MailTransportStage.Type,
  use: (client: ImapClient) => Promise<A>,
) =>
  Effect.tryPromise({
    try: async () => {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
        host: login.imap.host,
        port: login.imap.port,
        secure: login.imap.security === "tls",
        doSTARTTLS: login.imap.security === "starttls" ? true : undefined,
        auth: { user: login.username, pass: login.password },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
      // imapflow emits socket errors as events; unhandled ones would crash the server.
      client.on("error", () => undefined);
      await client.connect();
      try {
        return await use(client);
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
    catch: (cause) => new MailTransportError({ stage, reason: reasonOf(cause), cause }),
  });

/** imapflow and nodemailer, loaded on first use so they cost nothing until mail is used. */
const make = MailTransport.of({
  verify: Effect.fn("MailTransport.verify")(function* (login) {
    yield* withImap(login, "imap", async () => undefined);
    yield* Effect.tryPromise({
      try: async () => {
        const transport = await smtpTransport(login);
        try {
          await transport.verify();
        } finally {
          transport.close();
        }
      },
      catch: (cause) => new MailTransportError({ stage: "smtp", reason: reasonOf(cause), cause }),
    });
  }),
  listInbox: Effect.fn("MailTransport.listInbox")(function* (login, limit) {
    return yield* withImap(login, "imap", async (client) => {
      const { simpleParser } = await import("mailparser");
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const mailbox = client.mailbox;
        const exists = mailbox === false ? 0 : mailbox.exists;
        if (exists === 0) return [];
        const first = Math.max(1, exists - limit + 1);
        const messages: Array<MailSummary> = [];
        for await (const message of client.fetch(`${first}:*`, {
          uid: true,
          flags: true,
          envelope: true,
          source: { start: 0, maxLength: SNIPPET_SOURCE_BYTES },
        })) {
          const parsed = message.source
            ? await simpleParser(message.source).catch(() => null)
            : null;
          const envelope = message.envelope;
          messages.push({
            uid: String(message.uid),
            from: (envelope?.from ?? []).map(formatAddress).join(", "),
            to: (envelope?.to ?? []).map(formatAddress),
            subject: envelope?.subject ?? "",
            date: envelope?.date ?? null,
            snippet: snippetOf(parsed?.text),
            unread: !(message.flags?.has("\\Seen") ?? false),
          });
        }
        return messages.toReversed();
      } finally {
        lock.release();
      }
    });
  }),
  readMessage: Effect.fn("MailTransport.readMessage")(function* (login, uid) {
    return yield* withImap(login, "imap", async (client) => {
      const { simpleParser } = await import("mailparser");
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const message = await client.fetchOne(
          uid,
          { uid: true, flags: true, source: true },
          {
            uid: true,
          },
        );
        if (message === false || message.source === undefined) return null;
        const parsed = await simpleParser(message.source);
        const references = parsed.references;
        return {
          uid: String(message.uid),
          from: addressList(parsed.from).join(", "),
          to: addressList(parsed.to),
          cc: addressList(parsed.cc),
          subject: parsed.subject ?? "",
          date: parsed.date ?? null,
          snippet: snippetOf(parsed.text),
          unread: !(message.flags?.has("\\Seen") ?? false),
          text: parsed.text ?? "",
          messageId: parsed.messageId ?? null,
          references:
            references === undefined
              ? []
              : typeof references === "string"
                ? [references]
                : references,
        } satisfies MailMessage;
      } finally {
        lock.release();
      }
    });
  }),
  send: Effect.fn("MailTransport.send")(function* (login, mail, options) {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        const nodemailer = await import("nodemailer");
        const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
        const info = await composer.sendMail({
          from: mail.from,
          to: [...mail.to],
          cc: [...mail.cc],
          subject: mail.subject,
          text: mail.text,
          ...(mail.inReplyTo === undefined ? {} : { inReplyTo: mail.inReplyTo }),
          ...(mail.references === undefined ? {} : { references: [...mail.references] }),
        });
        return { message: info.message as Buffer, envelope: info.envelope };
      },
      catch: (cause) => new MailTransportError({ stage: "smtp", reason: "failed", cause }),
    });
    const sent = yield* Effect.tryPromise({
      try: async () => {
        const transport = await smtpTransport(login);
        try {
          return await transport.sendMail({ envelope: raw.envelope, raw: raw.message });
        } finally {
          transport.close();
        }
      },
      catch: (cause) => new MailTransportError({ stage: "smtp", reason: reasonOf(cause), cause }),
    });
    if (options.appendToSent) {
      yield* withImap(login, "append-sent", async (client) => {
        const folders = await client.list();
        const sentFolder = folders.find((folder) => folder.specialUse === "\\Sent");
        if (sentFolder === undefined) return;
        await client.append(sentFolder.path, raw.message, ["\\Seen"]);
      }).pipe(
        // The mail is out; a missing copy in Sent must not make it look unsent.
        Effect.catch((error) => Effect.logWarning("Could not file the sent mail in Sent.", error)),
      );
    }
    return { messageId: typeof sent.messageId === "string" ? sent.messageId : null };
  }),
});

export const layer = Layer.succeed(MailTransport, make);
