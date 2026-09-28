# 162. Missed-webhook catch-up via the app's delivery log

Date: 2026-09-28 · Status: accepted · Resolves the "future work" in 0003

## Context
GitHub never retries a failed delivery. Deploys, crashes and outages
(including `none` mode, ADR 0160) lose `issues.opened` events.

## Decision
- Actor **`delivery-catchup/main`** (one file, `src/lib/server/actors/`),
  app mode only. States: `idle → listing → redelivering → idle`, ticking at
  boot (+30 s) and every 10 min; I/O via a `github-app` I/O processor.
- Each pass: `GET /app/hook/deliveries?per_page=100` (app JWT), paging back
  until it reaches a delivery older than the checkpoint or 72 h (GitHub keeps
  about 3 days). For every delivery with `event` in {issues, installation,
  installation_repositories}, `redelivery: false`, status not 2xx, and whose
  `guid` is **not** already in `inbox`: `POST /app/hook/deliveries/{id}/attempts`
  (at most 50 per pass, spaced 200 ms). Redelivered events arrive through
  `/webhook` as usual; inbox dedupe by delivery id keeps it idempotent.
- Checkpoint (newest delivery `delivered_at` fully examined) in `kv`.
- Observability: spans via the normal trace path; counters
  `granary_catchup_redelivered_total`, `granary_catchup_last_pass_age_seconds`
  exported through ops metrics; a stale pass (> 1 h) raises an ops condition.
- **No issue-list reconciliation** in this iteration: redelivery covers 72 h
  of downtime; longer outages are an operator matter (manual note in the
  runbook). Can be added later without changing this design.

## Consequences
Downtime up to ~3 days self-heals after restart.
