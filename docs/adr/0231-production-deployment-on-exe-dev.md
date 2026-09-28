# 231. Production deployment: ta-granary and the shared ta-metrics stack

Date: 2026-09-28 · Status: accepted

## Context
First real deployment, on exe.dev (region FRA), following the manual's
exe.dev appendix. Observability should serve every tinyactors project, not
just granary.

## Decision
- **ta-metrics** (`https://ta-metrics.exe.xyz`, private, 30 GB, tag
  `tinyactors`): `grafana/otel-lgtm` run by Docker (`--restart
  unless-stopped`, container `lgtm`, data in `/var/lib/observability`),
  proxy on port 3000. Grafana authenticates via exe.dev's
  `X-ExeDev-Email` header (auth proxy, auto sign-up as Admin, login form and
  anonymous access off) — valid only because the VM stays private.
- **ta-metrics-otlp**: an exe.dev peer integration targeting
  `https://ta-metrics.exe.xyz:4318/`, attached to **`tag:tinyactors`**, so
  any tinyactors VM sends OTLP to `https://ta-metrics-otlp.int.exe.xyz`
  with no credential on the VM (the caller arrives as `X-Exedev-Source-Vm`).
- **ta-granary** (`https://ta-granary.exe.xyz`, public, 25 GB, tags
  `tinyactors,granary`): Bun 1.4.1 in `/opt/bun`, granary installed with
  `bun add -g` (from a `release:pack` tarball until the package is on npm),
  data in `/var/lib/granary`, systemd unit from `granary systemd-unit`,
  proxy headers enabled, telemetry seeded to ta-metrics-otlp (`exe-peer`).
- **Master key**: generated locally, stored in 1Password (Personal vault,
  item `granary`, field `master-key` — the fnox `prod` reference), written to
  `/var/lib/granary/master.key` (0600) before `granary init`; never printed.

## Consequences
New tinyactors services get telemetry by tagging their VM `tinyactors` and
pointing OTLP at `https://ta-metrics-otlp.int.exe.xyz`. Upgrades: copy a new
tarball (later: `bun add -g @tinyactors/granary@<tag>`) and
`systemctl restart granary`. Remaining manual steps: GitHub App via
`/settings/github`, R2 destination for off-site backups.
