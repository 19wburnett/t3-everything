import { describe, expect, it } from "vite-plus/test";
import type { BrowserCredential } from "@t3tools/contracts";

import { filterSavedLogins, offersBrowserPasswordImport } from "./savedLogins.logic";

describe("offersBrowserPasswordImport", () => {
  it("offers import only from the desktop app into its own primary backend", () => {
    expect(offersBrowserPasswordImport(true, { _tag: "PrimaryConnectionTarget" })).toBe(true);
    expect(offersBrowserPasswordImport(false, { _tag: "PrimaryConnectionTarget" })).toBe(false);
    for (const _tag of [
      "BearerConnectionTarget",
      "RelayConnectionTarget",
      "SshConnectionTarget",
    ] as const) {
      expect(offersBrowserPasswordImport(true, { _tag })).toBe(false);
    }
    expect(offersBrowserPasswordImport(true, null)).toBe(false);
  });
});

describe("filterSavedLogins", () => {
  const login = (
    id: string,
    origin: string,
    username: string,
    sourceName: string,
  ): BrowserCredential => ({ id, origin, username, sourceName, source: "browser" });
  const logins = [
    login("a", "https://github.com", "octo@example.com", "Chrome (Default)"),
    login("b", "https://app.example.com:8443", "admin", "Personal vault"),
    login("c", "not a url", "", "Firefox (default-release)"),
  ];

  it("matches host, username, and source case-insensitively", () => {
    expect(filterSavedLogins(logins, "  GITHUB ").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterSavedLogins(logins, "example.com").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(filterSavedLogins(logins, ":8443").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterSavedLogins(logins, "vault").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterSavedLogins(logins, "not a").map((entry) => entry.id)).toEqual(["c"]);
    expect(filterSavedLogins(logins, "https")).toEqual([]);
    expect(filterSavedLogins(logins, " ")).toBe(logins);
  });
});
