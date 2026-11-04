# Company channels

A company can connect email accounts and X, LinkedIn, and Threads accounts in
its Company hub. Agents read the inbox and write drafts; only you send them.
Credentials stay on the environment that runs the company and are never shown
again after you save them. Saving an account signs in with it first, so a
mistyped password or token is caught right away.

## Bring an existing company brain

Every agent reads `company/BRAIN.md` and `company/CHANNELS.md` before it works.
If your company already keeps this somewhere else, paste a website, a GitHub
repo (`owner/repo` works), or a Supabase project URL into **Already have a
company brain?** in the Company hub. This opens a Claude thread with the import
prompt ready to review. Claude reads the source, fills in `company/`, and records
where the brain came from so it can be refreshed later. Private repos need `gh`
signed in, and Supabase needs the Supabase MCP server or CLI on that machine.

## Drafts and sending

Drafts are Markdown files in the company folder's `company/outbox/`, one per
email or post, with its details in the frontmatter at the top. Agents in the
company's threads, and Muse or Grok Bot through their tasks, create them with
`t3_company_draft`; you can also write or edit them yourself. Review a draft in
the Company hub and send it there. Sending marks the file `sent` with the time
and, for posts, a link. A failed send is marked `failed` with the reason, and
you can fix the draft or the account and send it again. Sent drafts cannot be
sent twice or discarded; they stay as a record.

Posts longer than the network allows are refused with their length rather than
cut: X allows 280 characters, Threads 500, and LinkedIn 3,000.

## Connect an email account

**Gmail, iCloud, and Fastmail** use IMAP and SMTP with an app password, not your
normal password:

- Gmail: turn on 2-Step Verification, then create one at
  [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
- iCloud: at [account.apple.com](https://account.apple.com), open **Sign-In and
  Security → App-Specific Passwords**.
- Fastmail: **Settings → Privacy & Security → Manage app passwords**, with IMAP
  and SMTP access.

For another provider, choose **Other IMAP** and enter its IMAP and SMTP servers,
ports, and whether each uses TLS or STARTTLS. Sent mail is copied to the
account's Sent folder; Gmail does that by itself.

**Outlook and Microsoft 365** sign in with Microsoft, through an Azure app you
own:

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open
   **App registrations → New registration**. Choose who can sign in (any
   account type works for personal Outlook too). No redirect URI is needed.
2. Under **Authentication**, turn on **Allow public client flows**.
3. Under **API permissions**, add Microsoft Graph delegated permissions
   `Mail.ReadWrite`, `Mail.Send`, `User.Read`, and `offline_access`.
4. Copy the **Application (client) ID** into T3 Code. Leave the tenant as
   `common` unless your organization requires its own tenant ID.
5. Open the link T3 Code shows, enter the code, and approve.

## Connect a social account

**X**: in the [X developer portal](https://developer.x.com), set your app's
user authentication permissions to **Read and write**, then copy the API key
and secret and generate an access token and secret under **Keys and tokens**.
Tokens generated before you chose Read and write cannot post; regenerate them.
Posting needs an API plan that allows it.

**LinkedIn**: create an app at
[linkedin.com/developers](https://www.linkedin.com/developers) with the **Share
on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products, then
generate a token with the `openid`, `profile`, and `w_member_social` scopes in
the developer portal's token generator. Tokens last 60 days and cannot be
renewed here, so enter the expiry date LinkedIn shows. The account warns you a
week before it expires; paste a new token then.

**Threads**: in a [Meta developer](https://developers.facebook.com) app with the
Threads use case and the `threads_basic` and `threads_content_publish`
permissions, generate a user token and exchange it for a long-lived one, which
lasts 60 days. T3 Code renews it about once a week while you use the account. A
token left unused until it expires must be replaced.
