# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Browser → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox, Zen, and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Saved logins

Agents can sign in to sites in the preview browser with logins saved in T3 Code. An agent can fill
a login only on that login's own site, and it never sees the password. Manage logins in
**Settings → Browser → Saved logins**. They belong to the selected environment.

**Chrome or Firefox.** In the desktop app, with this machine's environment selected, choose
**Import from browser** and pick a browser profile. Close that browser first. Passwords are never
sent to a remote environment. Firefox profiles protected by a primary password cannot be imported.
Imported passwords are stored in the server's secrets directory, readable only by the account that
runs T3 Code. Importing the same profile again replaces its earlier logins.

**1Password.** Install the 1Password CLI (`op`) on the machine running the server and sign in with
`op signin`, then choose **Sync from 1Password**.

**Bitwarden.** Run `bw login` once on the machine running the server. Then unlock with your master
password in Settings and choose **Sync from Bitwarden**. The unlock lasts until the server restarts
or you choose **Lock**.

Synced 1Password and Bitwarden logins stay in your vault. T3 Code reads a value live when an agent
fills it and never copies it.
