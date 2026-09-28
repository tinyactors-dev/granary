# 151. A dev-only JSON API over the OpsBackend

Date: 2026-09-28 · Status: accepted

## Context
The ops scenario tests (ADR 0007: drive the running system from outside) need
to trigger backups/drills and read status, runs, conditions and sink stats.
The `/ops` pages use remote functions, whose endpoint ids are build hashes,
not a stable surface.

## Decision
`/__dev/api/ops/*` (`src/routes/__dev/api/ops/[...path]/+server.ts`) maps
GET `status | conditions | events | plans | destinations | runs[/<id>] |
drills | sinks[/<id>/stats] | secrets | keys | budgets | actors` and POST
`backup-now | drill-now | acknowledge | budgets` onto `getOpsBackend()`.
It only imports `$lib/ops/contract`. Like all of `/__dev` it is 404 unless
dev mode is on (ADR 0009); tests run the built app with `GRANARY_DEV=1` and a
free `DAP_PORT`. Secrets are never returned (the backend has no such method).

## Consequences
Also handy for `curl` in development. Not a production API.
