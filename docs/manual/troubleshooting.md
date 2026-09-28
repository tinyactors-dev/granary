# Troubleshooting

## Start here

```sh
sudo -u granary granary doctor --data /var/lib/granary   # Bun, data dir, master key, databases, disk, ORIGIN, GitHub
curl -s localhost:3000/readyz              # what the running server thinks of itself
journalctl -u granary -e                   # logs
```

`doctor` works with and without a running server. With one, it also
checks the actor system, the GitHub connection and ops. `/healthz` only
says the process is alive; `/readyz` answers 200 when the database, the
actor system and the backend are ready, and lists what still needs setup
(GitHub, master key, ops attention items).

## Common problems

**Webhooks answer 503.** GitHub isn't connected yet (setup mode) or was
disconnected. Connect it under Settings → GitHub.

**Webhooks answer 401.** The signature doesn't match the app's webhook
secret, which usually means a second, older app or a manual webhook still
points at this URL. Delete it on GitHub. The app created by granary is the
only thing that should send webhooks.

**Issues aren't closed.** Look at **Deliveries**. An *ignored* delivery
shows why (repository disabled or unknown, event not acted on). Look at
**Effects**. A *dead* effect gave up after 6 attempts; the error says why
(often permissions: the app needs *Issues: read & write*). **Retry**
re-queues it.

**"No master key".** granary can't find `GRANARY_MASTER_KEY` or
`<data>/master.key`. It still accepts webhooks, but nothing that needs
secrets runs: no GitHub App, no off-site backups, no authenticated sinks.
Restore the key from your password manager and restart. A lost key can't
be recovered; the encrypted secrets and backups are gone with it.

**Sign-in says "not allowed".** Only admins can sign in. Ask an admin to add
you under Settings → Admins, or run `granary admin add <login>` on the
server.

**Nobody can sign in.** Run `sudo -u granary granary login-link <admin-login>`
on the server.

**A command exits 4 ("data dir … does not exist / is not initialised /
cannot access").** The CLI looked at the wrong data directory or ran as the
wrong user. The message names the directory and how it was chosen (`--data`,
`GRANARY_DATA_DIR`, `/var/lib/granary`, or the per-user default). Run it as the
data directory's owner, e.g. `sudo -u granary granary <command> --data
/var/lib/granary`. Nothing was created or written.

**"no ORIGIN configured" from `login-link`.** Set `ORIGIN=https://…` (granary's
public URL) in `granary.env`, restart granary if it runs, and try again.

**Missed webhooks after an outage.** The catch-up re-sends failed deliveries
from the last 72 hours every 10 minutes (**Settings → GitHub → Missed
webhooks**). Older ones can be redelivered by hand from the app's
**Advanced** tab on GitHub.

**Backups postponed: disk.** The disk doesn't have room for a snapshot.
Free space or grow the disk. Ops shows how much is needed.

**The CLI says the server isn't running (exit 3)** but it is. The CLI
couldn't reach `<data>/admin.sock`. Use the same `--data` as the service,
and run as the service user. The socket is disabled when the data-directory
path is longer than about 100 bytes (a Unix socket limit); use a shorter
path.
