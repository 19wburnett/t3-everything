import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type {
  BrowserCredential,
  BrowserCredentialManager,
  BrowserCredentialManagerStatus,
} from "@t3tools/contracts";

/** Decrypted browser passwords may only reach the desktop's own backend, never a remote one. */
export function offersBrowserPasswordImport(
  hasDesktopBridge: boolean,
  target: Pick<ConnectionTarget, "_tag"> | null,
): boolean {
  return hasDesktopBridge && target?._tag === "PrimaryConnectionTarget";
}

export function savedLoginHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function filterSavedLogins(
  credentials: ReadonlyArray<BrowserCredential>,
  query: string,
): ReadonlyArray<BrowserCredential> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return credentials;
  return credentials.filter((credential) =>
    [savedLoginHost(credential.origin), credential.username, credential.sourceName].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

const MANAGER_STATUS_COPY: Readonly<
  Record<BrowserCredentialManager, Readonly<Record<BrowserCredentialManagerStatus, string>>>
> = {
  one_password: {
    not_installed: "Install the 1Password CLI (op) on the host.",
    signed_out: "Run op signin on the host.",
    locked: "Run op signin on the host.",
    ready: "Ready. Logins are read live from 1Password when an agent fills them.",
  },
  bitwarden: {
    not_installed: "Install the Bitwarden CLI (bw) on the host.",
    signed_out: "Run bw login on the host.",
    locked: "Locked. Unlock with your master password.",
    ready: "Unlocked until the server restarts or you lock it.",
  },
};

export function passwordManagerStatusCopy(
  manager: BrowserCredentialManager,
  status: BrowserCredentialManagerStatus,
): string {
  return MANAGER_STATUS_COPY[manager][status];
}
