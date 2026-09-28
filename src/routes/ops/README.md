# /ops admin pages (ADR 0092, 0104) — owner: D (/ops UI)

Talks to the backend only through `src/lib/remote/ops.remote.ts`, which uses
`getOpsBackend()` from `$lib/ops/contract`. Develop against the stub:
`GRANARY_STUB_BACKEND=1 GRANARY_STUB_OPS=1 ADMINS=admin bun --bun vite dev`.
Pages: `/ops`, `/ops/backups`, `/ops/destinations`, `/ops/telemetry`,
`/ops/conditions`, `/ops/drills`, `/ops/secrets`; plus the global banner.
