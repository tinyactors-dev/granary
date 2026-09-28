# 194. Delivery catch-up: implementation details

Date: 2026-09-28 · Status: accepted · Refines 0162 · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
- `delivery-catchup/main` (`src/lib/server/actors/delivery-catchup.ts`) is
  spawned at boot in app mode and when the mode becomes `app` (then it runs a
  pass at once). States `idle → listing → redelivering → idle`; the delayed
  `catchup.tick` is armed on entering `idle` (first after `firstDelayMs`,
  then `intervalMs`); `catchup.run-now` starts a pass immediately.
- I/O processor `github-app` (`src/lib/server/github/catchup.ts`):
  `catchup.list` walks `GET /app/hook/deliveries` (cursor via `Link`, ≤ 30
  pages) back to max(checkpoint, now − 72 h). Candidates: accepted events,
  `redelivery: false`, non-2xx, whose GUID has no later 2xx delivery and is
  not in the inbox; ≤ 50 per pass. `catchup.redeliver` posts `…/attempts`
  200 ms apart.
- The **checkpoint** (newest `delivered_at` examined) advances when a pass
  had no candidates, or when every redelivery request was accepted — a
  failed request is retried next pass.
- Pass results (`lastPassAt`, `lastPassRedelivered`, `totalRedelivered`,
  `lastError`) are stored in `github_settings` and shown in `GitHubStatus`.
- Cadence knobs for tests/ops: `GRANARY_CATCHUP_FIRST_DELAY_MS`,
  `GRANARY_CATCHUP_INTERVAL_MS` (defaults 30 s / 10 min).
- Not done yet (E6): exporting `granary_catchup_*` metrics and the "stale
  pass" ops condition — that needs an additive field in the ops host-health
  contract.
