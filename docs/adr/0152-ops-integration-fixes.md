# 152. Integration fixes between the ops features

Date: 2026-09-28 · Status: accepted

## Decision
- **Actor names:** `OpsContext.addresses()` (additive) exposes the addresses
  the ops System spawned or loaded; `listOpsActors` names actors from them
  (falling back to data-derived names), so no `#<slot>` entries remain.
- **Config import:** `composeBackend` routes `importConfig` through both
  halves: backups imports destinations/plans/budgets, health imports sinks
  (`HealthBackend.importSinks`, not part of the contract). Imported sinks,
  like destinations, arrive disabled until tested (ADR 0102).
- **Interval stretch:** a remediator `stretch-interval` is kept in kv
  (`backups:stretch:<planId>`, 24 h); `refreshInterval` never lowers the
  effective interval below it while it holds, so the next egress refresh no
  longer undoes it.
- **Stub status:** `StubOpsBackend.getStatus` reports the newest *finished*
  drill (a running one has no result), so it matches `OpsStatus`.
- **Sink timing in tests:** the telemetry-sink chart carries `timeScale`
  (from `OPS_TEST_GRACE_SCALE`, 1 in production) scaling its backoff and the
  60 s circuit probe, with a 200 ms floor.
