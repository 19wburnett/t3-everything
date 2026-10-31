const parseWebUrl = (value: string) => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
};

/** `scheme://host[:port]` for an http(s) URL; undefined for anything else. */
export const normalizeCredentialOrigin = (value: string): string | undefined => {
  const url = parseWebUrl(value);
  return url === undefined ? undefined : `${url.protocol}//${url.host}`;
};

/**
 * Whether a login saved for `origin` may be filled on `pageUrl`: the same scheme and port, and the
 * page host is the login's host or one of its subdomains. A leading `www.` on the login's host is
 * ignored, so a `www.example.com` login also fills on `example.com` and `app.example.com`.
 */
export const credentialMatchesUrl = (origin: string, pageUrl: string): boolean => {
  const credential = parseWebUrl(origin);
  const page = parseWebUrl(pageUrl);
  if (credential === undefined || page === undefined) return false;
  if (credential.protocol !== page.protocol || credential.port !== page.port) return false;
  const host = credential.hostname.replace(/^www\./, "");
  return page.hostname === host || page.hostname.endsWith(`.${host}`);
};
