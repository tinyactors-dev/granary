# 240. The setup checklist is computed on the server from the real state

Date: 2026-09-28 · Status: accepted

## Context
In production the Setup card on `/settings` never showed backups as done,
although an R2 destination held verified backups and a restore drill had
passed (`/readyz` ops = ok). The page drew the "Backups and telemetry" item
with a hard-coded "not done" icon; nothing computed it. The same card marked
"Admins" as done even with zero admins, and "GitHub" as done as soon as the
mode was not `none`, even with no repository guarded.

## Decision
`SetupStatus` gains `steps: SetupStep[]` (`id`, `title`, `status` =
`done` | `todo` | `attention`, `optional`, `detail`, `href`), computed by
`src/lib/server/setup-steps.ts` from the admin count, the GitHub status and
the ops status. The page and `granary doctor` only render it.

| Step | Done when |
|---|---|
| admins | at least one admin |
| github | the GitHub App is connected |
| repos | at least one repository of a non-suspended installation is enabled |
| backups | an off-site destination has a verified backup within its window **and** the latest restore drill passed — the backup half of the ops `sleepOk` rule (ADR 0100) |
| telemetry (optional) | an enabled sink has delivered at least once and is not failing |

`attention` means it worked before but is not working now (backups fell out
of their window, the last drill failed, a sink is failing, the master key is
missing). `todo` means not set up yet; `detail` names what is missing and
`href` points where to fix it. The card's heading counts the required steps
still open. `granary doctor` prints the same list under "setup".

## Consequences
`/settings`, `granary doctor`, `/ops` and `/readyz` agree. Covered by
`tests/setup-status.test.ts` (backup + drill against fake-infra flips the
backup step to done, in the CLI and in the rendered page).
