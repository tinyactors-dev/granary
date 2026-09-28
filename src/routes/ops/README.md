# /ops admin pages (ADR 0092, 0104, 0140–0142) — owner: D (/ops UI)

Talks to the backend only through `src/lib/remote/ops.remote.ts`, which uses
`getOpsBackend()` from `$lib/ops/contract`. Develop against the stub:
`GRANARY_STUB_BACKEND=1 GRANARY_STUB_OPS=1 GRANARY_SEED_ADMINS=admin bun --bun vite dev`,
then log in via `/admin/sessions`.

Pages: `/ops` (overview), `/ops/conditions`, `/ops/backups` (+ `[runId]`),
`/ops/destinations` (+ `new`, `[id]`), `/ops/plans`, `/ops/drills`,
`/ops/telemetry` (+ `new`, `[id]`), `/ops/secrets`, `/ops/settings`
(budgets, config export/import); plus the "while you were away" banner on the
Overview. Ops actors are listed in `/admin/actors` (ADR 0290). Components live in `src/lib/components/ops/`.
