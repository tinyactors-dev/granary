# Operations runbook

Day-2 tasks for a running instance installed as in [Install](install.md)
(Bun under `/opt/bun`, unit `granary.service`, data in `/var/lib/granary`).
Commands on the host run as the service user: `sudo -u granary granary …`.
For the tinyactors instance: host `ta-granary.exe.xyz`, public
`https://granary.tinyactors.dev`, Grafana `https://ta-metrics.exe.xyz`
(ADR 0231).

## Is it healthy?

```sh
curl -s https://<origin>/healthz        # alive + exact version
curl -s https://<origin>/readyz         # database, system, masterKey, github, ops
sudo -u granary granary doctor --data /var/lib/granary
journalctl -u granary -e                # recent logs;  -f to follow
systemctl status granary
```

`/readyz` lists what still needs you (e.g. `ops: attention`); **Ops** in the
UI shows the reasons. Nothing pages anyone: problems wait for your next visit
(the "while you were away" banner).

## Deploy, upgrade, roll back

```sh
mise run deploy -- --host <ssh-host> --dry-run   # preflight + plan
mise run deploy -- --host <ssh-host>             # pack HEAD, install, restart, wait for /healthz
mise run deploy -- --host <ssh-host> --tarball release/tinyactors-granary-<previous>.tgz   # roll back
```

Details and the by-hand steps: [Upgrades](upgrades.md). Take a backup first
when a release changes the database (`granary backup now`).

## Sign in when nobody can

```sh
ssh <ssh-host> sudo -u granary granary login-link <admin-login> --ttl 30m --data /var/lib/granary
```

Single use; built from `ORIGIN`. Exit 4 means wrong user or data directory
(the message says which); exit 1 "no ORIGIN" means `granary.env` lacks it.

## Admins, allowlist, GitHub

- Admins: **Settings → Admins**, or `granary admin add|remove|list`.
- Allowlist: **Allowlist** in the UI.
- GitHub: **Settings → GitHub** (installations, per-repo switches, missed
  webhooks). Webhooks dropped during an outage shorter than 72 hours are
  re-sent automatically.

## Backups and restore

- **Ops → Backups** shows runs and the last verified backup; **Ops →
  Drills** the restore drills. `granary backup now` / `granary backup list`
  from the host.
- Off-site copies need a destination (R2 in the EU jurisdiction,
  [Backups](backups.md)). *The tinyactors instance has no R2 destination
  yet: only the local copy on the VM exists until one is added.*
- Restore and disaster recovery: [Restore](restore.md). You need the master
  key (1Password: item `granary`, field `master-key`) and read access to
  the bucket.

## Rotate the master key

1. Generate a new key and store it in the password manager (as in
   [Install §4](install.md#without-ever-printing-the-key)); keep the old one
   as `master-key-previous`.
2. On the host: write the new key to `/var/lib/granary/master.key` (0600,
   owner `granary`) and add `GRANARY_MASTER_KEY_PREVIOUS=<old key>` to
   `granary.env`.
3. `sudo systemctl restart granary`. At boot every stored secret is
   re-encrypted under the new key (audited as `secret.rewrap`); new backups
   use the new key.
4. Backups made before the rotation still need the previous key: keep
   `GRANARY_MASTER_KEY_PREVIOUS` (and the password-manager entry) until they
   have aged out of retention.

## Telemetry

Grafana → **Explore**: Loki `{service_name="granary"}` (app) and
`{service_name="granary-ops"}` (backups) for logs, Tempo for traces (HTTP
spans like `POST /webhook`, actor spans like `issue macrostep issue.opened`),
Prometheus for `granary_*` / `ops_*`. A log line's trace id opens its trace.
Quick checks: problems `{service_name=~"granary|granary-ops"} | detected_level=~"error|warn"`,
webhooks `{service_name="granary"} | webhook_outcome!=""`, backups
`{service_name="granary-ops"} | backup_state!=""` — more in
[Telemetry](telemetry.md#useful-logql). On the host, `journalctl -u granary`
shows the same records as readable lines; `GRANARY_LOG_LEVEL=debug` in
`granary.env` (then restart) adds probe/asset requests and debug records. Sinks live under **Ops → Telemetry** ([Telemetry](telemetry.md)).

## Hostname changes

Follow [Install §7](install.md#7-settle-the-public-hostname-before-the-github-app):
DNS, the proxy/domain, `ORIGIN`, restart, new login link, and the four URL
fields of the GitHub App.
