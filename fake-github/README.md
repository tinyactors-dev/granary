# Fake GitHub

Separate Bun process emulating the subset of GitHub granary uses: REST
(issues, comments), webhooks, OAuth, plus a `/__control` API. Contract:
ADR 0006 / 0035; architecture: ADR 0060.

```sh
mise run fake-github          # http://localhost:4010 (config/dev.env)
open http://localhost:4010/   # open/reopen issues, faults, redeliver, state
```

Layout: `server.ts` (HTTP), `system.ts` (tinyactors System, reset,
snapshot), `actors/` (one actor per file: registry, repository, delivery,
faults, oauth), `io/` (`reply`, `webhook` I/O processors), `views.ts`,
`page.ts`, `ids.ts`, `schemas.ts` (control API).
