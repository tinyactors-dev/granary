# First run

## 1. The first admin

Admins are GitHub logins stored in granary's database. Only admins can sign
in to the UI. Add yourself on the server:

```sh
granary admin add <your-github-login> --data /var/lib/granary
granary admin list --data /var/lib/granary
```

This works whether or not the server is running: with a running server it
goes through the admin socket, otherwise it writes the database directly.
Later you can manage admins under **Settings → Admins**. The last admin can't
be removed.

## 2. Signing in before GitHub is connected

GitHub sign-in needs the GitHub App, which you haven't created yet. A
**login link** gets you in the first time:

```sh
granary login-link <your-github-login> --data /var/lib/granary
# https://granary.example.com/auth/link/…   (valid 15 minutes, single use)
```

Open the link and click **Continue**. The link works once. Only a hash of it
is stored, and opening it shows a confirmation page first, so chat and mail
link previews can't use it up. `--ttl 2h` makes it last longer (at most
24 h). Admins can also create links for each other under **Settings → Login
links**, and revoke unused ones there.

Until GitHub is connected, admins land on the setup page and webhooks are
refused with `503`.

## 3. Create the GitHub App

On **Settings → GitHub**:

1. Choose where the app lives: your personal account or an organization.
2. Optionally name it (default `granary-<host>`).
3. Click **Create GitHub App**. GitHub shows the app it is about to create
   (name, webhook URL `https://<origin>/webhook`, permissions *Issues:
   read & write*, *Metadata: read*, events *Issues*); confirm it.

GitHub sends you back to granary, which stores the app's private key,
webhook secret and client secret encrypted with the master key. Nothing is
copied by hand. From now on:

- the relay authenticates as the app, with short-lived installation tokens
- signing in to granary uses the app ("Sign in with GitHub")
- webhooks are verified with the app's webhook secret

## 4. Install it on repositories

Click **Install on GitHub** (or **Add repositories** later), pick the
account and the repositories, and confirm. GitHub sends you back and granary
lists the installation with its repositories.

Each repository has an on/off switch. Issues in a disabled repository are
received but ignored; `/deliveries` shows the reason. **Refresh** re-reads
installations from GitHub if something looks out of date.

## 5. Missed webhooks

GitHub does not retry failed webhook deliveries. granary checks the app's
delivery log every 10 minutes (the first check 30 seconds after start) and
asks GitHub to redeliver anything from the last 72 hours that failed and
never reached it. Restarts and short outages therefore lose nothing. The
**Missed webhooks** card on Settings → GitHub shows the last check.

## Disconnecting

**Settings → GitHub → Disconnect GitHub** stops granary acting on GitHub. It
deletes the stored app credentials and installations but keeps your
per-repository switches. Delete the app on GitHub as well (the page links to
its settings); otherwise it keeps sending webhooks that granary refuses.
Connecting again runs the setup above once more.

Next: [Allowlist and policy](allowlist-and-policy.md).
