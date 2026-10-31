// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

/** RFC 3986 percent-encoding, which OAuth 1.0a requires instead of encodeURIComponent's. */
const percentEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface OAuth1Credentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

export interface OAuth1Request {
  readonly method: string;
  /** Query parameters are signed with the rest. */
  readonly url: string;
  /** Form-encoded body parameters; JSON bodies are not signed. */
  readonly bodyParams?: Readonly<Record<string, string>>;
  readonly nonce: string;
  readonly timestampSeconds: number;
}

/** The HMAC-SHA1 signature and `Authorization` header for an X user-context request. */
export function signOAuth1(credentials: OAuth1Credentials, request: OAuth1Request) {
  const url = new URL(request.url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: request.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(request.timestampSeconds),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const pairs = [
    ...Object.entries(oauthParams),
    ...url.searchParams.entries(),
    ...Object.entries(request.bodyParams ?? {}),
  ]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .toSorted(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1));
  const parameterString = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const baseString = [
    request.method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(parameterString),
  ].join("&");
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const signature = NodeCrypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const header = `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
  return { signature, header };
}
