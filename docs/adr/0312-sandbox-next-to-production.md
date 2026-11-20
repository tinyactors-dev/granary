# 312. A sandbox next to production: a second granary on the fake GitHub

Date: 2026-11-20 · Status: accepted (automates the sandbox ADR 0290 only documented)

## Context
The maintainer wants to try features such as introductions (ADR 0310) on
the production machine, with the fakes, without any risk to the real
instance or to real GitHub users. ADR 0290 made simulation in production
inert by construction (the fake signs webhooks with its own app's secret, so
a production granary rejects them) and said a separate sandbox instance was
needed, documented but not automated. The npm package did not ship the fake
GitHub, and only one port of the exe.dev VM is public (granary's).

Whom it serves: the operator, playing on the real host. Who pays: one CLI
command pair, one systemd unit, the fake GitHub bundled into the package
(about 0.7 MB), one environment flag. Out of scope: exposing the sandbox
publicly, the load generator and fake-infra in the sandbox.

## Decision
- **`granary sandbox init --data <dir> [--port 3100] [--github-port 4010]
  [--admins admin]`** creates a separate data dir: a marker file
  (`sandbox.marker`), its own random master key (a sandbox never stores
  anything real), and a `granary.env` with `GRANARY_SANDBOX=1`,
  `GRANARY_DEV=1` (log in as anyone, the fake GitHub's controls under
  /admin), `HOST=127.0.0.1`, GitHub URLs pointing at the fake on localhost and
  `GRANARY_DEV_GITHUB_AUTOCONNECT=1`. `--data` is required.
- **`granary sandbox serve --data <dir>`** starts the fake GitHub
  (`dist/fake-github.js`, built by `mise run cli` and shipped in the package)
  as a child process bound to 127.0.0.1, waits for it, then serves the app.
  When the fake ends on its own, the sandbox exits (systemd restarts both).
- **Never mixed up:** `granary serve` and `granary init` refuse a marked data
  dir; `granary sandbox serve` refuses an unmarked one; `sandbox init` refuses
  a data dir that already holds a granary database without the marker.
- **Never talks to GitHub:** with `GRANARY_SANDBOX=1` the app refuses to start
  unless `GRANARY_GITHUB_API_URL` and `GRANARY_GITHUB_WEB_URL` are loopback
  URLs; the fake never calls github.com.
- **Never public:** both listen on 127.0.0.1. You reach them through an SSH
  tunnel of both ports (the fake serves the sign-in and "GitHub" pages):
  `ssh -L 3100:127.0.0.1:3100 -L 4010:127.0.0.1:4010 <host>`, then
  `http://localhost:3100`.
- **Visibly a sandbox:** a strip on every page says so (not one of the page
  banners of ADR 0291).
- **`granary systemd-unit --unit sandbox`** prints `granary-sandbox.service`.
- New variables `GRANARY_SANDBOX` and `FAKE_GITHUB_HOST` (ADR 0230 table).

## Consequences
The maintainer can run the whole product, introductions included, against
the fake on the production VM and throw it away with `rm -rf` of the
sandbox's data dir. The updater restarts only `granary`; restart
`granary-sandbox` after an update to run the new version there too.
