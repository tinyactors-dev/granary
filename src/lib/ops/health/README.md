# ops health (ADR 0100, 0101, 0123) — owner: B (telemetry & self-healing, M3)

| File | What |
|---|---|
| `signals.ts` | the watchdog's measurements: host health, disk, ops.sqlite, sinks → one sample per condition |
| `policies.ts` | per condition kind: remediation ladder, grace/settle periods, texts for the morning |
| `journal.ts` | `conditions`, `ops_events`, `admin_visits`, `kv` access; Condition DTOs |
| `status.ts` | `status()` (`sleepOk` + reasons) and the "while you were away" banner |
