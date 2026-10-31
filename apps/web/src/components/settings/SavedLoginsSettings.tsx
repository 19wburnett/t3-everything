import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  BROWSER_IMPORT_FAILURE_COPY,
  type BrowserCredential,
  type BrowserCredentialImportResult,
  type BrowserCredentialManagerStatus,
  type BrowserImportSource,
  type BrowserImportSourceProfile,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { isElectron } from "~/env";
import { browserCredentialEnvironment } from "~/state/browserCredentials";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { importFailureReason } from "./browserImportWizard.logic";
import {
  filterSavedLogins,
  offersBrowserPasswordImport,
  passwordManagerStatusCopy,
  savedLoginHost,
} from "./savedLogins.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FILTER_THRESHOLD = 8;
const MAX_RENDERED_LOGINS = 200;

type Notice = { readonly tone: "error" | "info"; readonly text: string } | null;

function failureNotice(result: AtomCommandResult<unknown, unknown>): Notice {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  return { tone: "error", text: formatEnvironmentQueryError(result.cause) };
}

function countNotice(verb: string, result: BrowserCredentialImportResult): Notice {
  const logins = `${result.imported.toLocaleString()} ${result.imported === 1 ? "login" : "logins"}`;
  return { tone: "info", text: `${verb} ${logins} (${result.skipped.toLocaleString()} skipped)` };
}

function noticeText(notice: Notice) {
  if (notice === null) return null;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={notice.tone === "error" ? "text-destructive" : undefined}
    >
      {notice.text}
    </p>
  );
}

export function SavedLoginsSettings() {
  const { environment } = useSettingsScope();
  const search = searchableSetting("browser-saved-logins");
  return (
    <SettingsSection id="saved-logins" title={search.title}>
      {environment === null ? (
        <SettingsRow
          {...search}
          description="Connect to an environment to manage its saved logins."
        />
      ) : (
        <SavedLoginsControls
          key={environment.environmentId}
          environmentId={environment.environmentId}
          target={environment.entry.target}
        />
      )}
    </SettingsSection>
  );
}

function SavedLoginsControls({
  environmentId,
  target,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ConnectionTarget;
}) {
  const list = useEnvironmentQuery(browserCredentialEnvironment.list({ environmentId, input: {} }));
  const managers = list.data?.managers ?? null;
  return (
    <>
      <LoginsRow
        environmentId={environmentId}
        target={target}
        credentials={list.data?.credentials ?? null}
        error={list.error}
      />
      <OnePasswordRow environmentId={environmentId} status={managers?.one_password ?? null} />
      <BitwardenRow environmentId={environmentId} status={managers?.bitwarden ?? null} />
    </>
  );
}

function LoginsRow({
  environmentId,
  target,
  credentials,
  error,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ConnectionTarget;
  readonly credentials: ReadonlyArray<BrowserCredential> | null;
  readonly error: string | null;
}) {
  const canImport = useAtomValue(browserCredentialEnvironment.import.permissionAtom(environmentId));
  const canRemove = useAtomValue(browserCredentialEnvironment.remove.permissionAtom(environmentId));
  const runImport = useAtomCommand(browserCredentialEnvironment.import, { reportFailure: false });
  const runRemove = useAtomCommand(browserCredentialEnvironment.remove, { reportFailure: false });
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<"import" | "remove" | null>(null);
  const busy = pending !== null;
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);
  const importOffered = canImport && offersBrowserPasswordImport(previewBridge !== null, target);

  const importFrom = async (source: BrowserImportSource, profile: BrowserImportSourceProfile) => {
    const bridge = previewBridge;
    if (bridge === null || busy) return;
    setPending("import");
    setNotice(null);
    const entries = await bridge
      .readBrowserPasswords({ sourceId: source.id, sourceProfileDirectory: profile.directory })
      .catch((cause: unknown) => {
        setNotice({ tone: "error", text: BROWSER_IMPORT_FAILURE_COPY[importFailureReason(cause)] });
        return null;
      });
    if (entries === null) {
      setPending(null);
      return;
    }
    const result = await runImport({
      environmentId,
      input: { sourceName: `${source.name} (${profile.name})`.slice(0, 128), entries },
    });
    setPending(null);
    setNotice(
      result._tag === "Success" ? countNotice("Imported", result.value) : failureNotice(result),
    );
  };

  const remove = async (credentialIds: ReadonlyArray<BrowserCredential["id"]>) => {
    setPending("remove");
    setNotice(null);
    const result = await runRemove({ environmentId, input: { credentialIds } });
    setPending(null);
    setConfirmRemoveAll(false);
    setNotice(failureNotice(result));
  };

  const filtered = credentials === null ? [] : filterSavedLogins(credentials, filter);
  const visible = filtered.slice(0, MAX_RENDERED_LOGINS);

  return (
    <SettingsRow
      {...searchableSetting("browser-saved-logins")}
      title="Logins"
      description="Agents can fill these logins on the matching site without seeing the password."
      status={
        error !== null
          ? noticeText({ tone: "error", text: error })
          : notice !== null
            ? noticeText(notice)
            : isElectron && canImport && !importOffered
              ? "Select this machine's environment to import logins from a browser."
              : null
      }
      control={
        importOffered || (canRemove && credentials !== null && credentials.length > 0) ? (
          <>
            {importOffered ? (
              <BrowserPasswordImportMenu
                disabled={busy}
                importing={pending === "import"}
                onImport={(source, profile) => void importFrom(source, profile)}
              />
            ) : null}
            {canRemove && credentials !== null && credentials.length > 0 ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => setConfirmRemoveAll(true)}
              >
                Remove all
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      <div className="mt-2 mb-2 space-y-2">
        {credentials !== null && credentials.length > FILTER_THRESHOLD ? (
          <Input
            type="search"
            size="sm"
            placeholder="Filter by site, username, or source"
            aria-label="Filter saved logins"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        {credentials === null ? (
          error === null ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading saved logins…
            </p>
          ) : null
        ) : credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">No saved logins yet.</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">No logins match “{filter.trim()}”.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-border/60">
            {visible.map((credential, index) => {
              const host = savedLoginHost(credential.origin);
              return (
                <div
                  key={credential.id}
                  className={
                    index > 0
                      ? "flex items-center gap-3 border-t border-border/60 px-3 py-2"
                      : "flex items-center gap-3 px-3 py-2"
                  }
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{host}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {credential.username || "No username"} · {credential.sourceName}
                    </p>
                  </div>
                  {canRemove ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={busy}
                      aria-label={`Remove ${credential.username || "login"} for ${host}`}
                      onClick={() => void remove([credential.id])}
                    >
                      <Trash2Icon />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {filtered.length > visible.length ? (
          <p className="text-xs text-muted-foreground">
            Showing {visible.length.toLocaleString()} of {filtered.length.toLocaleString()}. Filter
            to find others.
          </p>
        ) : null}
      </div>
      <AlertDialog
        open={confirmRemoveAll}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRemoveAll(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all saved logins?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents can no longer fill them. Imported passwords are deleted from this environment;
              items in 1Password and Bitwarden stay in their vaults and can be synced again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || credentials === null}
              onClick={() => {
                if (credentials !== null) void remove(credentials.map((entry) => entry.id));
              }}
            >
              {pending === "remove" ? "Removing…" : "Remove all"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

function BrowserPasswordImportMenu({
  disabled,
  importing,
  onImport,
}: {
  readonly disabled: boolean;
  readonly importing: boolean;
  readonly onImport: (source: BrowserImportSource, profile: BrowserImportSourceProfile) => void;
}) {
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const loadSources = () => {
    void previewBridge
      ?.listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  };
  const importable = (sources ?? []).filter(
    (source) =>
      source.profiles.length > 0 &&
      source.unavailable !== "notInstalled" &&
      source.unavailable !== "unsupportedPlatform",
  );
  return (
    <Menu onOpenChange={(open) => open && loadSources()}>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        {importing ? "Importing…" : "Import from browser"}
      </MenuTrigger>
      <MenuPopup align="end">
        {sources === null ? (
          <MenuItem disabled>Looking for browsers…</MenuItem>
        ) : importable.length === 0 ? (
          <MenuItem disabled>No supported browsers found</MenuItem>
        ) : (
          importable.map((source, index) => (
            <MenuGroup key={source.id}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroupLabel>{source.name}</MenuGroupLabel>
              {source.profiles.map((profile) => (
                <MenuItem key={profile.directory} onClick={() => onImport(source, profile)}>
                  {profile.name}
                </MenuItem>
              ))}
            </MenuGroup>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}

function OnePasswordRow({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: BrowserCredentialManagerStatus | null;
}) {
  const canSync = useAtomValue(browserCredentialEnvironment.sync.permissionAtom(environmentId));
  const runSync = useAtomCommand(browserCredentialEnvironment.sync, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const sync = async () => {
    setBusy(true);
    setNotice(null);
    const result = await runSync({ environmentId, input: { manager: "one_password" } });
    setBusy(false);
    setNotice(
      result._tag === "Success" ? countNotice("Synced", result.value) : failureNotice(result),
    );
  };

  return (
    <SettingsRow
      title="1Password"
      description={
        status === null ? "Checking…" : passwordManagerStatusCopy("one_password", status)
      }
      status={noticeText(notice)}
      control={
        status === "ready" && canSync ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()}>
            {busy ? "Syncing…" : "Sync from 1Password"}
          </Button>
        ) : null
      }
    />
  );
}

function BitwardenRow({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: BrowserCredentialManagerStatus | null;
}) {
  const canUnlock = useAtomValue(
    browserCredentialEnvironment.unlockBitwarden.permissionAtom(environmentId),
  );
  const canLock = useAtomValue(
    browserCredentialEnvironment.lockBitwarden.permissionAtom(environmentId),
  );
  const canSync = useAtomValue(browserCredentialEnvironment.sync.permissionAtom(environmentId));
  const runUnlock = useAtomCommand(browserCredentialEnvironment.unlockBitwarden, {
    reportFailure: false,
  });
  const runLock = useAtomCommand(browserCredentialEnvironment.lockBitwarden, {
    reportFailure: false,
  });
  const runSync = useAtomCommand(browserCredentialEnvironment.sync, { reportFailure: false });
  const [masterPassword, setMasterPassword] = useState("");
  const [pending, setPending] = useState<"unlock" | "lock" | "sync" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const unlock = async () => {
    if (masterPassword === "" || pending !== null) return;
    const input = { masterPassword };
    setMasterPassword("");
    setPending("unlock");
    setNotice(null);
    const result = await runUnlock({ environmentId, input });
    setPending(null);
    setNotice(failureNotice(result));
  };

  const lock = async () => {
    setPending("lock");
    setNotice(null);
    const result = await runLock({ environmentId, input: {} });
    setPending(null);
    setNotice(failureNotice(result));
  };

  const sync = async () => {
    setPending("sync");
    setNotice(null);
    const result = await runSync({ environmentId, input: { manager: "bitwarden" } });
    setPending(null);
    setNotice(
      result._tag === "Success" ? countNotice("Synced", result.value) : failureNotice(result),
    );
  };

  return (
    <SettingsRow
      title="Bitwarden"
      description={status === null ? "Checking…" : passwordManagerStatusCopy("bitwarden", status)}
      status={noticeText(notice)}
      control={
        status === "locked" && canUnlock ? (
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <div className="min-w-0 flex-1 @min-[32rem]/settings-row:w-48 @min-[32rem]/settings-row:flex-none">
              <Input
                type="password"
                size="sm"
                autoComplete="off"
                placeholder="Master password"
                aria-label="Bitwarden master password"
                disabled={pending !== null}
                value={masterPassword}
                onChange={(event) => setMasterPassword(event.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={pending !== null || masterPassword === ""}>
              {pending === "unlock" ? "Unlocking…" : "Unlock"}
            </Button>
          </form>
        ) : status === "ready" && (canSync || canLock) ? (
          <>
            {canSync ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void sync()}
              >
                {pending === "sync" ? "Syncing…" : "Sync from Bitwarden"}
              </Button>
            ) : null}
            {canLock ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void lock()}
              >
                {pending === "lock" ? "Locking…" : "Lock"}
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  );
}
