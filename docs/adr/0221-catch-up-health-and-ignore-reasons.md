# 221. Catch-up health in ops; stored ignore reasons

Date: 2026-09-28 · Status: accepted

## Decision
- `HostHealthSnapshot` gains an optional `catchup` block (enabled only in
  app mode; interval, last pass, redelivered counts, last error). The ops
  watchdog raises **`catchup-stale`** (grace 1 h, needs confirmation) when
  the last pass is older than max(3 × interval, 30 min) or failed. Metrics:
  `granary_catchup_redelivered_total`, `granary_catchup_last_pass_redelivered`,
  `granary_catchup_last_pass_age_seconds`, `granary_catchup_failing`.
- The inbox stores why a delivery is `ignored` (migration 4,
  `inbox.ignore_reason`): the repo policy's reason (repo disabled/unknown)
  or `<event>.<action> is not acted on`. `DeliverySummary.ignoreReason`
  shows it on `/deliveries`.
