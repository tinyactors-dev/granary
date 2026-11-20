# 301. Every push to main is released to `dev`, and hosts pull it

Date: 2026-11-20 · Status: accepted

Builds on 0185 (release channels), 0186 (one release script, GitHub Actions)
and 0233 (`mise run deploy`).

## Context
Deploying took two manual steps: run the release workflow, then
`mise run deploy` from a laptop over SSH. The production VM is reachable only
with the maintainer's exe.dev SSH key, and npm keeps a new version in an
automated review for some minutes after it accepts the upload: a deploy that
ran right after the release found no version to install.

Whom it serves: the maintainer, who wants every green push on the host
without doing anything. It costs one workflow, one CLI command and a timer
on each host that opts in.

## Decision
- **Every push to `main`** runs the `main` workflow: the test suite
  (`mise run test`) against the built app, then the release workflow
  (called with `workflow_call`) with `channel=dev`, which packs, verifies on
  amd64 and arm64, and publishes `<next patch>-dev.<epoch>.g<sha>` under the
  npm dist-tag `dev` through trusted publishing. A newer push supersedes a
  waiting run. Docs-only pushes are released too: the stream is rolling.
- **Hosts pull.** `granary update [--channel dev|latest]` reads the
  channel's dist-tag from the registry and the running version from
  `/healthz`; when they differ it installs the new version under
  `BUN_INSTALL` (`bun add -g --force`), restarts `granary.service`, waits for
  `/healthz` to report it, and reinstalls the version that ran before when it
  does not come up. A version npm has not released yet is retried at the
  next run. A systemd timer runs it as root every five minutes;
  `granary systemd-unit --unit update-service|update-timer` prints both units.
- **GitHub holds no credential for any host**, and CI never touches
  production: it only publishes to npm.
- `mise run deploy` stays for deploying something else (a tarball, a pinned
  version) and for hosts without the timer.

## Consequences
- The npm trusted publisher must allow direct `npm publish`: staged
  publishes would wait for a manual approval and stop the stream.
- A host following `dev` runs every green push within the timer interval
  plus npm's review time; pinning a version means stopping the timer.
- The updater restarts the service: a short outage per update, as with
  `mise run deploy` (missed webhooks are re-sent by the catch-up, 0162).
- Migrations still only go forward: a rollback by the updater to a version
  that refuses the newer database needs the manual restore of
  `docs/manual/upgrades.md`.
