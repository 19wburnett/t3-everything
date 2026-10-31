import { describe, expect, it } from "@effect/vitest";

import { credentialMatchesUrl, normalizeCredentialOrigin } from "./origin.ts";

describe("credentialMatchesUrl", () => {
  it.each([
    ["https://example.com", "https://example.com/login", true],
    ["https://example.com", "https://app.example.com/login", true],
    ["https://example.com", "https://a.b.example.com/", true],
    ["https://www.example.com", "https://example.com/", true],
    ["https://www.example.com", "https://app.example.com/", true],
    ["https://example.com", "https://www.example.com/", true],
    ["https://app.example.com", "https://example.com/", false],
    ["https://app.example.com", "https://other.example.com/", false],
    ["https://example.com", "http://example.com/", false],
    ["http://example.com", "https://example.com/", false],
    ["https://example.com", "https://example.com:8443/", false],
    ["https://example.com:8443", "https://example.com/", false],
    ["https://example.com:8443", "https://example.com:8443/", true],
    ["https://example.com:443", "https://example.com/", true],
    ["http://localhost:3000", "http://localhost:3000/", true],
    ["http://localhost:3000", "http://localhost:3001/", false],
    ["https://example.com", "https://evilexample.com/", false],
    ["https://example.com", "https://example.com.evil.io/", false],
    ["https://example.com", "https://evil.io/example.com", false],
    ["https://example.com", "https://example.com@evil.io/", false],
    ["https://wwwexample.com", "https://example.com/", false],
    ["https://EXAMPLE.com", "https://app.example.COM/", true],
    ["https://example.com", "about:blank", false],
    ["https://example.com", "file:///example.com", false],
    ["https://example.com", "not a url", false],
    ["ftp://example.com", "ftp://example.com/", false],
  ])("%s on %s: %s", (origin, url, expected) => {
    expect(credentialMatchesUrl(origin, url)).toBe(expected);
  });
});

describe("normalizeCredentialOrigin", () => {
  it.each([
    ["https://Accounts.Example.com/signin?next=/", "https://accounts.example.com"],
    ["http://localhost:3000/login", "http://localhost:3000"],
    ["https://example.com:443/", "https://example.com"],
    ["android://hash@com.example.app/", undefined],
    ["", undefined],
    ["example.com", undefined],
  ])("%s", (value, expected) => {
    expect(normalizeCredentialOrigin(value)).toBe(expected);
  });
});
