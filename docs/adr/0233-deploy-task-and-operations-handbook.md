# 233. `mise run deploy` and the operations handbook

Date: 2026-09-28 · Status: accepted

## Context
The first production deployment (ADR 0231) was done by hand and surfaced
traps: Bun's install cache reused a tarball copied to the same path (the
service kept running the old build), the CLI needed `sudo -u granary`, the
GitHub App bakes `ORIGIN` into its URLs, a failed manifest conversion leaves
an orphaned app on GitHub, and `fnox set` writes plaintext into `fnox.toml`
for the 1Password provider.

## Decision
- **`mise run deploy`** (`tools/deploy/deploy.ts`, TypeBox-validated
  arguments) is the standard upgrade path for hosts installed per
  `docs/manual/install.md`: preflight over SSH (Bun under `/opt/bun`, the
  `granary` binary, `granary.service`, `granary.env`, passwordless `sudo`),
  pack `HEAD` (clean tree required) unless `--tarball` or `--npm <tag|version>`
  is given, copy under the versioned file name, `bun add -g --force`,
  verify `granary version`, restart, wait until `/healthz` reports the new
  version on the host and at `ORIGIN`, print `/readyz`, remove the tarball.
  `--dry-run` stops after preflight and the plan. Scripts go to the host on
  stdin (`bash -s`), never on the command line. Rollback = deploy an older
  tarball or npm version.
- The manual gains an **operations runbook** and documents: installing from
  a tarball before the npm release; the no-print master-key path (1Password
  item via `op item create --template`, `master.key` before `init`, hash
  verification; never `fnox set`); settling the hostname before the GitHub
  App and the four app URL fields to edit otherwise; the wizard as the only
  way to connect an app and deleting an orphaned app; the shared
  observability VM (auth proxy via `X-ExeDev-Email` only while private, peer
  integration on a tag, `https://…int.exe.xyz`).
- The project README documents releasing: trusted publishing needs an
  existing package, so the first publish (stable `0.1.0`) uses a token.

## Consequences
Deploys are one command and verify themselves end to end. The non-dry path
was exercised piecewise (pack, versioned copy + `--force` install, restart,
`/healthz` polling were each done by hand on ta-granary on 2026-09-28); the
tool itself was run against production only with `--dry-run`.
