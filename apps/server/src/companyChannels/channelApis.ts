import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const X_API = "https://api.x.com/2";
const LINKEDIN_API = "https://api.linkedin.com";
// LinkedIn serves each monthly version for a year; bump it before then.
const LINKEDIN_VERSION = "202609";
const THREADS_API = "https://graph.threads.net";
const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const MICROSOFT_SCOPES = "offline_access Mail.ReadWrite Mail.Send User.Read";

const TIMEOUT = Duration.seconds(30);
// fetch would carry the bearer token or signed request to any redirect target.
const NO_REDIRECT: RequestInit = { redirect: "manual" };
const MAX_DETAIL = 300;

export const ChannelProvider = Schema.Literals(["x", "linkedin", "threads", "microsoft"]);
export type ChannelProvider = typeof ChannelProvider.Type;

const PROVIDER_NAMES: Record<ChannelProvider, string> = {
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  microsoft: "Microsoft",
};

export class ChannelApiError extends Schema.TaggedError<ChannelApiError>()("ChannelApiError", {
  provider: ChannelProvider,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: Schema.Literals(["auth", "unreachable", "rejected", "invalid_response"]),
  /** The provider's own short explanation, when it gave one. */
  providerMessage: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    const name = PROVIDER_NAMES[this.provider];
    const said = this.providerMessage === undefined ? "" : `: ${this.providerMessage}`;
    switch (this.reason) {
      case "auth":
        return `${name} refused the saved credentials (${this.operation})${said}. Reconnect the account.`;
      case "unreachable":
        return `Could not reach ${name} (${this.operation}).`;
      case "rejected":
        return `${name} refused ${this.operation} (HTTP ${this.status ?? "?"})${said}.`;
      case "invalid_response":
        return `${name} answered ${this.operation} with something unexpected.`;
    }
  }
}

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

const ProblemBody = Schema.Struct({
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        message: Schema.optional(Schema.String),
        code: Schema.optional(Schema.Unknown),
      }),
    ]),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});
const decodeProblem = Schema.decodeUnknownOption(Schema.fromJsonString(ProblemBody));

const boundedText = (text: string | undefined) => {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line;
};

const problemMessage = (text: string) =>
  Option.match(decodeProblem(text), {
    onNone: () => undefined,
    onSome: (problem) =>
      boundedText(
        problem.detail ??
          problem.error_description ??
          (typeof problem.error === "object" ? problem.error.message : undefined) ??
          problem.errors?.[0]?.message ??
          problem.message ??
          problem.title ??
          (typeof problem.error === "string" ? problem.error : undefined),
      ),
  });

const send = Effect.fn("CompanyChannelApis.send")(function* (
  http: HttpClient.HttpClient,
  provider: ChannelProvider,
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
) {
  yield* Effect.annotateCurrentSpan({
    "company_channel.provider": provider,
    "company_channel.operation": operation,
  });
  const response = yield* http.execute(request).pipe(
    Effect.flatMap((res) =>
      Effect.map(res.text, (text) => ({ status: res.status, headers: res.headers, text })),
    ),
    // Client spans would record query strings, which carry Threads tokens.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
    Effect.timeout(TIMEOUT),
    Effect.mapError(
      (cause) =>
        new ChannelApiError({ provider, operation, status: null, reason: "unreachable", cause }),
    ),
  );
  yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
  return response satisfies RawResponse;
});

const failFor = (provider: ChannelProvider, operation: string, response: RawResponse) => {
  const providerMessage = problemMessage(response.text);
  return new ChannelApiError({
    provider,
    operation,
    status: response.status,
    reason: response.status === 401 || response.status === 403 ? "auth" : "rejected",
    ...(providerMessage === undefined ? {} : { providerMessage }),
  });
};

const expectJson = <S extends Schema.Top>(
  provider: ChannelProvider,
  operation: string,
  response: RawResponse,
  schema: S,
) => {
  if (response.status < 200 || response.status >= 300) {
    return Effect.fail(failFor(provider, operation, response));
  }
  return Schema.decodeEffect(Schema.fromJsonString(schema))(response.text).pipe(
    Effect.mapError(
      (cause) =>
        new ChannelApiError({
          provider,
          operation,
          status: response.status,
          reason: "invalid_response",
          cause,
        }),
    ),
  );
};

const expectOk = (provider: ChannelProvider, operation: string, response: RawResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(failFor(provider, operation, response));

const jsonHeaders = { accept: "application/json", "user-agent": "t3code" };

/** Signs `method url` for X; the caller owns the nonce and clock. */
export type XSigner = (method: string, url: string) => Effect.Effect<string>;

export const xMe = Effect.fn("CompanyChannelApis.xMe")(function* (
  http: HttpClient.HttpClient,
  sign: XSigner,
) {
  const url = `${X_API}/users/me`;
  const response = yield* send(
    http,
    "x",
    "reading the account",
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({ ...jsonHeaders, authorization: yield* sign("GET", url) }),
    ),
  );
  const body = yield* expectJson(
    "x",
    "reading the account",
    response,
    Schema.Struct({ data: Schema.Struct({ id: Schema.String, username: Schema.String }) }),
  );
  return body.data;
});

export const xPost = Effect.fn("CompanyChannelApis.xPost")(function* (
  http: HttpClient.HttpClient,
  sign: XSigner,
  text: string,
) {
  const url = `${X_API}/tweets`;
  const response = yield* send(
    http,
    "x",
    "the post",
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ ...jsonHeaders, authorization: yield* sign("POST", url) }),
      HttpClientRequest.bodyJsonUnsafe({ text }),
    ),
  );
  const body = yield* expectJson(
    "x",
    "the post",
    response,
    Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
  );
  return body.data.id;
});

export const linkedInUserInfo = Effect.fn("CompanyChannelApis.linkedInUserInfo")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
) {
  const response = yield* send(
    http,
    "linkedin",
    "reading the member",
    HttpClientRequest.get(`${LINKEDIN_API}/v2/userinfo`).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeaders(jsonHeaders),
    ),
  );
  return yield* expectJson(
    "linkedin",
    "reading the member",
    response,
    Schema.Struct({ sub: Schema.String, name: Schema.optional(Schema.String) }),
  );
});

export const linkedInPost = Effect.fn("CompanyChannelApis.linkedInPost")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  authorUrn: string,
  text: string,
) {
  const response = yield* send(
    http,
    "linkedin",
    "the post",
    HttpClientRequest.post(`${LINKEDIN_API}/rest/posts`).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeaders({
        ...jsonHeaders,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      }),
      HttpClientRequest.bodyJsonUnsafe({
        author: authorUrn,
        commentary: text,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    ),
  );
  yield* expectOk("linkedin", "the post", response);
  const urn = response.headers["x-restli-id"];
  if (urn === undefined || urn === "") {
    return yield* new ChannelApiError({
      provider: "linkedin",
      operation: "the post",
      status: response.status,
      reason: "invalid_response",
    });
  }
  return urn;
});

const threadsUrl = (path: string, params: Record<string, string>) =>
  `${THREADS_API}${path}?${new URLSearchParams(params).toString()}`;

export const threadsMe = Effect.fn("CompanyChannelApis.threadsMe")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
) {
  const response = yield* send(
    http,
    "threads",
    "reading the account",
    HttpClientRequest.get(
      threadsUrl("/v1.0/me", { fields: "id,username", access_token: accessToken }),
    ).pipe(HttpClientRequest.setHeaders(jsonHeaders)),
  );
  return yield* expectJson(
    "threads",
    "reading the account",
    response,
    Schema.Struct({ id: Schema.String, username: Schema.optional(Schema.String) }),
  );
});

const IdBody = Schema.Struct({ id: Schema.String });

export const threadsPublish = Effect.fn("CompanyChannelApis.threadsPublish")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  userId: string,
  text: string,
) {
  const user = encodeURIComponent(userId);
  const container = yield* send(
    http,
    "threads",
    "the post",
    HttpClientRequest.post(
      threadsUrl(`/v1.0/${user}/threads`, { media_type: "TEXT", text, access_token: accessToken }),
    ).pipe(HttpClientRequest.setHeaders(jsonHeaders)),
  ).pipe(Effect.flatMap((response) => expectJson("threads", "the post", response, IdBody)));
  const published = yield* send(
    http,
    "threads",
    "publishing the post",
    HttpClientRequest.post(
      threadsUrl(`/v1.0/${user}/threads_publish`, {
        creation_id: container.id,
        access_token: accessToken,
      }),
    ).pipe(HttpClientRequest.setHeaders(jsonHeaders)),
  ).pipe(
    Effect.flatMap((response) => expectJson("threads", "publishing the post", response, IdBody)),
  );
  // The post is live by now; a missing permalink only costs the link.
  const permalink = yield* send(
    http,
    "threads",
    "reading the post",
    HttpClientRequest.get(
      threadsUrl(`/v1.0/${encodeURIComponent(published.id)}`, {
        fields: "permalink",
        access_token: accessToken,
      }),
    ).pipe(HttpClientRequest.setHeaders(jsonHeaders)),
  ).pipe(
    Effect.flatMap((response) =>
      expectJson(
        "threads",
        "reading the post",
        response,
        Schema.Struct({ permalink: Schema.optional(Schema.String) }),
      ),
    ),
    Effect.map((body) => body.permalink ?? null),
    Effect.orElseSucceed(() => null),
  );
  return { mediaId: published.id, permalink };
});

export const threadsRefresh = Effect.fn("CompanyChannelApis.threadsRefresh")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
) {
  const response = yield* send(
    http,
    "threads",
    "refreshing the token",
    HttpClientRequest.get(
      threadsUrl("/refresh_access_token", {
        grant_type: "th_refresh_token",
        access_token: accessToken,
      }),
    ).pipe(HttpClientRequest.setHeaders(jsonHeaders)),
  );
  return yield* expectJson(
    "threads",
    "refreshing the token",
    response,
    Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number }),
  );
});

const DeviceCodeBody = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});

const microsoftUrl = (tenant: string, path: string) =>
  `${MICROSOFT_LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/${path}`;

export const microsoftDeviceCode = Effect.fn("CompanyChannelApis.microsoftDeviceCode")(function* (
  http: HttpClient.HttpClient,
  tenant: string,
  clientId: string,
) {
  const response = yield* send(
    http,
    "microsoft",
    "starting the sign-in",
    HttpClientRequest.post(microsoftUrl(tenant, "devicecode")).pipe(
      HttpClientRequest.setHeaders(jsonHeaders),
      HttpClientRequest.bodyUrlParams({ client_id: clientId, scope: MICROSOFT_SCOPES }),
    ),
  );
  return yield* expectJson("microsoft", "starting the sign-in", response, DeviceCodeBody);
});

const TokenBody = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export interface MicrosoftTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
}

export type MicrosoftPoll =
  | { readonly _tag: "Tokens"; readonly tokens: MicrosoftTokens }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown" }
  | { readonly _tag: "Refused"; readonly error: string };

/** The token endpoint answers 400 with `error` while the user has not finished. */
const postToken = Effect.fn("CompanyChannelApis.postToken")(function* (
  http: HttpClient.HttpClient,
  tenant: string,
  operation: string,
  form: Record<string, string>,
) {
  const response = yield* send(
    http,
    "microsoft",
    operation,
    HttpClientRequest.post(microsoftUrl(tenant, "token")).pipe(
      HttpClientRequest.setHeaders(jsonHeaders),
      HttpClientRequest.bodyUrlParams(form),
    ),
  );
  if (response.status >= 500) return yield* failFor("microsoft", operation, response);
  return yield* expectJson("microsoft", operation, { ...response, status: 200 }, TokenBody).pipe(
    Effect.map((body) => ({ body, status: response.status })),
  );
});

const tokensFrom = (body: typeof TokenBody.Type): MicrosoftTokens | null =>
  body.access_token === undefined
    ? null
    : {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        expiresInSeconds: body.expires_in ?? 3600,
      };

export const microsoftPollToken = Effect.fn("CompanyChannelApis.microsoftPollToken")(function* (
  http: HttpClient.HttpClient,
  tenant: string,
  clientId: string,
  deviceCode: string,
) {
  const { body } = yield* postToken(http, tenant, "finishing the sign-in", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: deviceCode,
  });
  const tokens = tokensFrom(body);
  if (tokens !== null) return { _tag: "Tokens", tokens } satisfies MicrosoftPoll;
  if (body.error === "authorization_pending") return { _tag: "Pending" } satisfies MicrosoftPoll;
  if (body.error === "slow_down") return { _tag: "SlowDown" } satisfies MicrosoftPoll;
  return { _tag: "Refused", error: body.error ?? "unknown" } satisfies MicrosoftPoll;
});

export const microsoftRefresh = Effect.fn("CompanyChannelApis.microsoftRefresh")(function* (
  http: HttpClient.HttpClient,
  tenant: string,
  clientId: string,
  refreshToken: string,
) {
  const { body, status } = yield* postToken(http, tenant, "refreshing the sign-in", {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES,
  });
  const tokens = tokensFrom(body);
  if (tokens !== null) return tokens;
  const providerMessage = boundedText(body.error_description?.split("\n")[0] ?? body.error);
  return yield* new ChannelApiError({
    provider: "microsoft",
    operation: "refreshing the sign-in",
    status,
    reason: body.error === "invalid_grant" ? "auth" : "rejected",
    ...(providerMessage === undefined ? {} : { providerMessage }),
  });
});

const graph = (accessToken: string, request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeaders({ ...jsonHeaders, Prefer: 'outlook.body-content-type="text"' }),
  );

const GraphRecipient = Schema.Struct({
  emailAddress: Schema.Struct({
    name: Schema.optional(Schema.String),
    address: Schema.optional(Schema.String),
  }),
});
type GraphRecipient = typeof GraphRecipient.Type;

export const formatGraphRecipient = (recipient: GraphRecipient | undefined) => {
  const { name, address } = recipient?.emailAddress ?? {};
  return name && address && name !== address ? `${name} <${address}>` : (address ?? name ?? "");
};

const GraphMessageSummary = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  from: Schema.optional(Schema.NullOr(GraphRecipient)),
  toRecipients: Schema.optional(Schema.Array(GraphRecipient)),
  receivedDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  bodyPreview: Schema.optional(Schema.String),
  isRead: Schema.optional(Schema.Boolean),
});

export const graphMe = Effect.fn("CompanyChannelApis.graphMe")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
) {
  const response = yield* send(
    http,
    "microsoft",
    "reading the mailbox owner",
    graph(
      accessToken,
      HttpClientRequest.get(`${GRAPH_API}/me?$select=mail,userPrincipalName,displayName`),
    ),
  );
  const me = yield* expectJson(
    "microsoft",
    "reading the mailbox owner",
    response,
    Schema.Struct({
      mail: Schema.optional(Schema.NullOr(Schema.String)),
      userPrincipalName: Schema.optional(Schema.NullOr(Schema.String)),
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  );
  return me.mail ?? me.userPrincipalName ?? me.displayName ?? "";
});

const SUMMARY_FIELDS = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";

export const graphListInbox = Effect.fn("CompanyChannelApis.graphListInbox")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  limit: number,
) {
  const query = new URLSearchParams({
    $top: String(limit),
    $select: SUMMARY_FIELDS,
    $orderby: "receivedDateTime desc",
  });
  const response = yield* send(
    http,
    "microsoft",
    "listing the inbox",
    graph(
      accessToken,
      HttpClientRequest.get(`${GRAPH_API}/me/mailFolders/inbox/messages?${query.toString()}`),
    ),
  );
  const body = yield* expectJson(
    "microsoft",
    "listing the inbox",
    response,
    Schema.Struct({ value: Schema.Array(GraphMessageSummary) }),
  );
  return body.value;
});

export const graphReadMessage = Effect.fn("CompanyChannelApis.graphReadMessage")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  messageId: string,
) {
  const select = `${SUMMARY_FIELDS},ccRecipients,body,internetMessageId,internetMessageHeaders`;
  const response = yield* send(
    http,
    "microsoft",
    "reading the message",
    graph(
      accessToken,
      HttpClientRequest.get(
        `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}?$select=${select}`,
      ),
    ),
  );
  if (response.status === 404) return null;
  return yield* expectJson(
    "microsoft",
    "reading the message",
    response,
    Schema.Struct({
      ...GraphMessageSummary.fields,
      ccRecipients: Schema.optional(Schema.Array(GraphRecipient)),
      body: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.String) })),
      internetMessageId: Schema.optional(Schema.NullOr(Schema.String)),
      internetMessageHeaders: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      ),
    }),
  );
});

const recipients = (addresses: ReadonlyArray<string>) =>
  addresses.map((address) => ({ emailAddress: { address } }));

export const graphSendMail = Effect.fn("CompanyChannelApis.graphSendMail")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  mail: {
    readonly to: ReadonlyArray<string>;
    readonly cc: ReadonlyArray<string>;
    readonly subject: string;
    readonly text: string;
  },
) {
  const response = yield* send(
    http,
    "microsoft",
    "sending the mail",
    graph(
      accessToken,
      HttpClientRequest.post(`${GRAPH_API}/me/sendMail`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          message: {
            subject: mail.subject,
            body: { contentType: "Text", content: mail.text },
            toRecipients: recipients(mail.to),
            ccRecipients: recipients(mail.cc),
          },
          saveToSentItems: true,
        }),
      ),
    ),
  );
  yield* expectOk("microsoft", "sending the mail", response);
});

export const graphReply = Effect.fn("CompanyChannelApis.graphReply")(function* (
  http: HttpClient.HttpClient,
  accessToken: string,
  messageId: string,
  reply: {
    readonly to: ReadonlyArray<string>;
    readonly cc: ReadonlyArray<string>;
    readonly text: string;
  },
) {
  const response = yield* send(
    http,
    "microsoft",
    "sending the reply",
    graph(
      accessToken,
      HttpClientRequest.post(
        `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}/reply`,
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          comment: reply.text,
          ...(reply.to.length === 0 && reply.cc.length === 0
            ? {}
            : {
                message: {
                  ...(reply.to.length === 0 ? {} : { toRecipients: recipients(reply.to) }),
                  ...(reply.cc.length === 0 ? {} : { ccRecipients: recipients(reply.cc) }),
                },
              }),
        }),
      ),
    ),
  );
  yield* expectOk("microsoft", "sending the reply", response);
});
