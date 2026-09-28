# 140. /ops UI: structure, remote functions and stub wiring

Date: 2026-09-28 · Status: accepted · Implements 92, 104

## Decision
- `/ops` is a section of the main app (main-nav entry "Ops") with its own
  sub-navigation (`src/lib/components/ops/OpsNav.svelte`, rendered by
  `src/routes/ops/+layout.svelte`): Overview, Conditions, Backups (+ run
  detail), Destinations (+ new/edit), Plans, Restore drills, Telemetry
  (+ new/edit), Secrets, Budgets & config, Actors. The dev-portal style of
  swapping the sidebar is not used: ops is part of the product, not a tool.
- All data goes through `src/lib/remote/ops.remote.ts`, which imports only
  `$lib/ops/contract` (ADR 0080) and delegates to `getOpsBackend()`.
  `OpsBackendError` maps to HTTP errors via `opsBackendErrorStatus`.
  Reads require a signed-in user; every mutation requires an admin
  (`requireAdmin()`), including test connection (it uses credentials),
  download links, config export and import. `markOpsVisited` only needs a user.
- Commands that change lists refresh them server-side: no-argument queries
  with `.refresh()`, argument queries the client names with `.updates(…)`
  via `requested(query, n).refreshAll()` (e.g. run now → `listOpsRuns`,
  drill now → `listOpsDrills`). Paginated lists reuse `PagedTable`.
- `GRANARY_STUB_OPS=1` registers the in-memory `StubOpsBackend` in
  `hooks.server.ts` `init` (before the granary backend, and independent of
  it), so the UI can be developed with
  `GRANARY_STUB_BACKEND=1 GRANARY_STUB_OPS=1 ADMINS=admin bun --bun vite dev`.
- Client components import ops types only (`import type … from
  '$lib/ops/contract'`), so client bundles don't pull in TypeBox; the few
  helpers needed on the client (R2 endpoint, validation patterns) are
  mirrored in `src/lib/components/ops/format.ts`.
- Charts follow the dataviz skill: projections and budgets are meters
  (fill = severity, track = lighter step of the same hue, icon + word for
  warn/over, never colour alone), counts are plain stat tiles. No multi-series
  charts, so no categorical palette.

## Consequences
The UI works unchanged against the real module once agent B registers it.
A route for anything new in `OpsBackend` is a remote function plus a page.
