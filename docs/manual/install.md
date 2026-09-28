# Install

## 1. Bun and the package, system-wide

granary runs on [Bun](https://bun.sh) 1.4.1 or newer. Installing Bun and
granary under `/opt/bun` makes them usable by a dedicated service user and
keeps them outside home directories, which the systemd unit hides:

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/opt/bun bash
sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g @tinyactors/granary        # stable (dist-tag latest)
# or: … bun add -g @tinyactors/granary@dev                                     # frequent builds (dist-tag dev)
sudo ln -sf /opt/bun/bin/bun /opt/bun/bin/granary /usr/local/bin/
granary version
```

For a personal install, `bun add -g @tinyactors/granary` in your own
account is enough.

## 2. Before the package is on npm: from a tarball

Until a release is published (or to run an unreleased commit), build a
tarball with `mise run release:pack` (or `mise run release -- pack --channel
dev`) in a checkout and install that. Copy it under its **versioned file
name** and install with **`--force`**: Bun's install cache keys a local
tarball by its path, so reinstalling a different build from the same path
(e.g. `/tmp/granary.tgz`) silently keeps the old version.

```sh
scp release/tinyactors-granary-<version>.tgz host:/tmp/
ssh host 'sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g --force /tmp/tinyactors-granary-<version>.tgz \
  && granary version && rm /tmp/tinyactors-granary-<version>.tgz'
```

Once the host is set up, [`mise run deploy`](upgrades.md#mise-run-deploy)
does this (and the restart and checks) for you.

The package contains the built server, the `granary` command and this
manual. Its only runtime dependencies are `@tinyactors/node`, which ships
prebuilt native code for Linux and macOS (no compiler needed), and
`@sinclair/typebox`.

## 3. A service user and the data directory

Everything granary stores lives in one data directory: `granary.sqlite`,
`ops.sqlite`, the master key file, `granary.env`, the admin socket and
backups staged for upload.

```sh
sudo useradd --system --home /var/lib/granary --shell /usr/sbin/nologin granary
sudo install -d -o granary -g granary -m 0700 /var/lib/granary
```

Without `--data`, commands use `GRANARY_DATA_DIR`, else `/var/lib/granary`
if it exists, else `$XDG_STATE_HOME/granary`, else `~/.local/state/granary`.
Run every `granary` command on the server as the service user
(`sudo -u granary granary …`): the data directory is private to it. Only
`init` and `serve` create anything; any other command refuses (exit 4) a data
directory that is missing, not initialised, or not readable by you, and names
the directory it looked at — it never quietly writes somewhere else.

## 4. `granary init`

Run this as the service user:

```sh
sudo -u granary granary init --data /var/lib/granary --origin https://granary.example.com
```

`init` creates the data directory (mode 0700), generates the **master key**
and prints it once, writes it to `master.key` (mode 0600), and writes
`granary.env`. It asks you to type part of the key back to prove you stored
it. `--yes-i-stored-the-key` skips that for automation.

> **Store the master key in a password manager before you continue.** It
> encrypts every stored secret (GitHub App key, R2 credentials, telemetry
> tokens) and every off-site backup. If the machine is lost and the key is
> only on its disk, your backups can never be decrypted.

Instead of the file you can pass the key as `GRANARY_MASTER_KEY`, for example
from a secret manager. `init` refuses to run while granary is running.

### Without ever printing the key

If the key shouldn't appear on any terminal, create it yourself and put it in
place **before** `init`; `init` then uses the existing `master.key` and prints
nothing. With 1Password (item `granary`, field `master-key`, the reference
`fnox.toml`'s `prod` profile uses):

```sh
umask 077
KEY=$(openssl rand -hex 32)
jq -n --arg k "$KEY" '{title:"granary", category:"SECURE_NOTE",
  fields:[{id:"master-key", label:"master-key", type:"CONCEALED", value:$k}]}' > item.json
op item create --vault Personal --template item.json && rm item.json
printf '%s\n' "$KEY" | ssh host 'sudo install -o granary -g granary -m 0600 /dev/stdin /var/lib/granary/master.key'
unset KEY
# verify by hash, never by value:
fnox get -P prod GRANARY_MASTER_KEY | tr -d '\n' | shasum -a 256
ssh host 'sudo cat /var/lib/granary/master.key | tr -d "\n" | sha256sum'
```

Don't use `fnox set` to store the value: with the 1Password provider it writes
the **plaintext value into `fnox.toml`** instead of into 1Password. Keep
`fnox.toml` a reference, and pass secrets to `op` in a 0600 template file,
never on the command line.

Without the key, stored secrets and every backup are unrecoverable: keep it in
the password manager, not only on the host.

`granary.env` holds only process settings:

| Variable | Meaning |
|---|---|
| `ORIGIN` | Public URL, e.g. `https://granary.example.com` (required for sign-in and the GitHub App) |
| `HOST`, `PORT` | Where to listen (default `0.0.0.0:3000`) |
| `PROTOCOL_HEADER`, `HOST_HEADER` | Trust `X-Forwarded-Proto` / `X-Forwarded-Host` from your reverse proxy |
| `GRANARY_MASTER_KEY` | The master key, if you don't use `master.key` |
| `GRANARY_SEED_ADMINS` | Optional seed: comma-separated admin logins, applied once |

Everything else is configured in the product. Environment variables for
it exist only as optional one-time seeds (`granary config seed`).

## 5. systemd

```sh
granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service
sudo systemctl daemon-reload
sudo systemctl enable --now granary
journalctl -u granary -f
```

The unit runs `granary serve` as user `granary` (`--user` to change it),
reads `granary.env`, restarts on failure, and is hardened
(`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, only the data
directory writable). It records the absolute paths of Bun and `granary` at
generation time, so regenerate it if either moves.

Check it's up:

```sh
curl -s localhost:3000/healthz   # {"status":"ok",...}: the process is alive
curl -s localhost:3000/readyz    # 200 once database, actors and backend are ready
granary doctor --data /var/lib/granary
```

## 6. Reverse proxy and TLS

granary speaks plain HTTP. Put it behind anything that terminates TLS, and
tell granary to trust the forwarded headers by uncommenting
`PROTOCOL_HEADER=x-forwarded-proto` and `HOST_HEADER=x-forwarded-host` in
`granary.env`. `ORIGIN` must be the public `https://` URL.

Caddy:

```
granary.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
	server_name granary.example.com;
	listen 443 ssl;
	# ssl_certificate …; ssl_certificate_key …;
	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	}
}
```

When the proxy runs on the same machine, set `HOST=127.0.0.1` so granary
isn't reachable around it. `/webhook` must stay publicly reachable, because
GitHub delivers webhooks there.

## 7. Settle the public hostname before the GitHub App

The GitHub App granary creates for you has its URLs baked in, all derived from
`ORIGIN`: homepage, webhook `…/webhook`, OAuth callback `…/auth/callback` and
setup URL `…/settings/github/installed`. Choose the final hostname **first**:

1. Point DNS at the host. For a subdomain, a `CNAME` to the host (or your
   proxy). On Cloudflare, set the record to **DNS only (grey cloud)** when the
   host terminates TLS itself (as exe.dev does); proxying it breaks the host's
   certificate issuance.
2. Tell your proxy/hosting about the name (on exe.dev: `ssh exe.dev domain add
   <vm> <hostname>`; TLS certificates are then issued automatically).
3. Set `ORIGIN=https://<hostname>` in `granary.env` and `sudo systemctl
   restart granary`. Check `curl -s https://<hostname>/readyz`.

Sessions are per hostname: after a change, sign in again with a new
`granary login-link`. If the hostname changes after the app exists, edit these
fields in the app's settings on GitHub (Settings → Developer settings → GitHub
Apps → your app): **Homepage URL**, **Webhook URL**, **Callback URL** and
**Setup URL**, with the new origin and the paths above.

Next: [First run](first-run.md).
