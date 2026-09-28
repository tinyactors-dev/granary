# 124. granary's host health provider

Date: 2026-09-28 · Status: accepted · Implements 80 (`OpsHost.health`)

## Decision
`src/lib/server/ops-health.ts` builds `HostHealthSnapshot` synchronously
from prepared statements on granary's WAL: outbox counts by state, the
oldest pending/inflight effect's age (its delivery's `received_at`, falling
back to `updated_at`), pending inbox count/age, the relay's last success
(`MAX(updated_at)` of done rows), the last webhook (`MAX(received_at)`).
Quarantined actors are counted from `system.actors()` at most every 10 s.
Event-loop lag is a 500 ms drift timer (p99 over 2 min); RSS from
`process.memoryUsage()`. Dead letters come from a new counter on the
runtime (`Runtime.stats.deadLetters`, incremented in the system's
`deadLetter` hook) — the only change to `system.ts`.
