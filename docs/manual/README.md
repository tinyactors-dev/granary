# granary operator manual

granary watches GitHub `issues` webhooks and closes issues opened by people
who aren't on your allowlist, with one polite comment. It keeps its own
state in SQLite, backs that up off-site (encrypted), and ships logs, traces
and metrics to Grafana if you want it to.

Everything except a handful of process settings is configured in the
product: the GitHub connection, admins, the allowlist, backup destinations
and telemetry. You need the command line only to install, bootstrap the
first admin and for disaster recovery.

## Requirements

- Linux (x86-64 or arm64) or macOS, with systemd if you want the provided
  service unit.
- [Bun](https://bun.sh) 1.4.1 or newer.
- A public HTTPS URL for this instance (GitHub must reach `/webhook`), for
  example behind nginx, Caddy or your hosting provider's proxy.
- A GitHub account or organization where you can create a GitHub App.
- Optional: an S3-compatible bucket (Cloudflare R2 recommended) for
  off-site backups, and an OTLP endpoint (Grafana) for telemetry.

## Quick start (about 10 minutes)

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/opt/bun bash
sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g @tinyactors/granary   # stable (dist-tag latest); before the
#   first npm release: copy a release:pack tarball and `bun add -g --force <file>` (Install §2)
sudo ln -sf /opt/bun/bin/bun /opt/bun/bin/granary /usr/local/bin/
sudo useradd --system --home /var/lib/granary --shell /usr/sbin/nologin granary
sudo install -d -o granary -g granary -m 0700 /var/lib/granary
sudo -u granary granary init --data /var/lib/granary --origin https://granary.example.com
#   → prints the master key ONCE: store it in your password manager now
sudo -u granary granary admin add <your-github-login> --data /var/lib/granary
granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service
sudo systemctl daemon-reload && sudo systemctl enable --now granary
sudo -u granary granary login-link <your-github-login> --data /var/lib/granary
#   → open the printed URL, confirm, and follow Settings → GitHub
```

Set the final public hostname (`ORIGIN`) before the next step: the GitHub App
bakes it into its URLs ([Install §7](install.md#7-settle-the-public-hostname-before-the-github-app)).
Then, in the browser: create the GitHub App (one click), install it on the
repositories to guard, add allowed users under **Policy**, and add a
backup destination under **Ops → Destinations**.

## Contents

1. [Install](install.md): Bun, the package, the service user, `granary init`,
   systemd, reverse proxy and TLS
2. [First run](first-run.md): first admin, login links, the GitHub App,
   choosing repositories
3. [Allowlist and policy](allowlist-and-policy.md): who gets closed and why
4. [Backups](backups.md): R2 in the EU jurisdiction, destinations, plans,
   retention, restore drills
5. [Restore](restore.md): restoring a backup, disaster recovery on a new host
6. [Telemetry](telemetry.md): Grafana, OTLP sinks, what is exported
7. [Upgrades](upgrades.md): release channels, upgrading and rolling back
8. [CLI reference](cli.md), generated from the CLI itself
9. [Troubleshooting](troubleshooting.md): `granary doctor`, `/readyz`,
   common failures
10. [Operations runbook](operations-runbook.md): health, deploys and
    rollbacks, login links, key rotation, telemetry
11. [Appendix: an exe.dev VM](appendix-exe-dev.md): a worked example, with a
    shared observability VM and a custom hostname

Source and issues: <https://github.com/tinyactors-dev/granary>.
