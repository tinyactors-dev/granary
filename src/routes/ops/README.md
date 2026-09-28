# /ops admin pages (ADR 0092, 0104, 0140–0142) — owner: D (/ops UI)

Talks to the backend only through `src/lib/remote/ops.remote.ts`, which uses
`getOpsBackend()` from `$lib/ops/contract`. Develop against the stub:
`GRANARY_STUB_BACKEND=1 GRANARY_STUB_OPS=1 ADMINS=admin bun --bun vite dev`,
then log in via `/__dev/sessions`.

Pages: `/ops` (overview), `/ops/conditions`, `/ops/backups` (+ `[runId]`),
`/ops/destinations` (+ `new`, `[id]`), `/ops/plans`, `/ops/drills`,
`/ops/telemetry` (+ `new`, `[id]`), `/ops/secrets`, `/ops/settings`
(budgets, config export/import), `/ops/actors`; plus the global banner in the
root layout. Components live in `src/lib/components/ops/`.
