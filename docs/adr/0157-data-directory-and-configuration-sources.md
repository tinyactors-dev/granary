# 157. Data directory, configuration sources and the master key

Date: 2026-09-28 · Status: accepted · Amends 0005, 0036, 0086/0117 (key name) · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
**Data directory** (everything granary owns on disk):
`--data <dir>` > `GRANARY_DATA_DIR` > `$XDG_STATE_HOME/granary` >
`~/.local/state/granary`. The systemd unit uses `/var/lib/granary`
(`StateDirectory=granary`). Layout:

| Path | What |
|---|---|
| `granary.sqlite` (+ `-wal`, `-shm`) | inbox/outbox/verdicts/allowlist/sessions, admins, login links, GitHub connection, secrets |
| `ops.sqlite` | ops module (ADR 0080+) |
| `master.key` | master key, mode 0600 (only if written by `granary init`) |
| `granary.env` | optional env file read by `granary serve` (mode 0600) |
| `admin.sock` | CLI ↔ server socket, mode 0600, dir 0700 (ADR 0159) |
| `granary.pid` | written by `serve`, advisory |
| `spool/`, `local-backups/` | ops (existing) |

`DATABASE_PATH` keeps working (dev/tests); when set, the data dir defaults to
its directory, as `boot.ts` already does for ops.

**Configuration sources**, highest first: CLI flags → process env →
`<data>/granary.env` → in-product settings (SQLite) → defaults. Only
*process-level* settings stay env/flags: `ORIGIN` (public URL, needed by the
adapter at start for CSRF), `HOST`, `PORT`, `PROTOCOL_HEADER`/`HOST_HEADER`
(reverse proxies), the data dir, the master key, `NODE_ENV`, `GRANARY_DEV`.
Everything else — GitHub connection, admins, allowlist, ops destinations/sinks
— is in-product; the corresponding env vars are **seeds** applied only when
the in-product value is absent (never overwrite UI edits; ADR 0102 rules).
`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_{ID,SECRET}` and
`ADMINS` stop being required (`REQUIRED_SECRETS` goes away).
`granary serve` never auto-loads a `.env` from the working directory (Bun
would): it passes `--env-file=<data>/granary.env` explicitly or none.

**Master key** — renamed `GRANARY_MASTER_KEY` (`OPS_MASTER_KEY` /
`OPS_MASTER_KEY_PREVIOUS` remain accepted aliases; `GRANARY_MASTER_KEY_PREVIOUS`
is the new rotation name). Sources: env > `<data>/master.key`. It is **never
generated silently** outside dev mode: `granary init` generates it, prints it
once, and requires the operator to type the last 6 characters back (or pass
`--yes-i-stored-the-key`) before writing `master.key`. Without a key,
`serve` starts in a degraded "no master key" state: webhooks still land in the
inbox, but nothing that needs secrets runs, and `/readyz` reports it. Losing
the key = losing secrets and off-site backups, which is why the manual makes
storing it in a password manager step one.

## Consequences
Dev keeps `config/dev.env`; the dev key file (`ops-master.key`) behaviour stays
dev-only.
