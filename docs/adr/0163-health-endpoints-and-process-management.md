# 163. Health endpoints, systemd, reverse proxies

Date: 2026-09-28 · Status: accepted

## Decision
- `GET /healthz` → 200 `{status:'ok', version}` whenever the HTTP server
  answers (liveness). `GET /readyz` → 200 when `granary.sqlite` is open, the
  tinyactors system booted and the boot re-post finished; 503 otherwise. Body
  (`ReadyzResponse`): `{ ready, version, uptimeSeconds, checks: { database,
  system, masterKey: 'ok'|'missing', github: 'ready'|'needs-github'|'error',
  ops: 'ok'|'attention'|'unavailable' } }`. Only `database` and `system`
  affect readiness; the rest is information. Both skip auth, sessions and
  logging-per-request; neither leaks config.
- **systemd:** `granary systemd-unit [--user granary] [--data
  /var/lib/granary] [--bin <path>]` prints a unit (`Type=simple`,
  `ExecStart=<bun> <bin> serve --data …`, `Restart=on-failure`,
  `StateDirectory=granary`, `StateDirectoryMode=0700`,
  `EnvironmentFile=-/var/lib/granary/granary.env`, `NoNewPrivileges`,
  `ProtectSystem=strict`, `ReadWritePaths=/var/lib/granary`,
  `KillSignal=SIGTERM`, `TimeoutStopSec=30`). Logs go to stdout/stderr →
  journald; no log files.
- **Binding:** `HOST` default `0.0.0.0`, `PORT` default 3000. Behind any TLS
  terminator/reverse proxy set `ORIGIN=https://…` and, if needed,
  `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=x-forwarded-host`
  (svelte-adapter-bun). exe.dev (proxy on :3000, `share set-public`) is a
  manual appendix example, nothing more.

## Consequences
Deploy scripts and monitors have stable probes; the product has no
host-specific code.
