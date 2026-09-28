# ops actors — one file per actor (ADR 0082, 0101)

Message catalogue and addresses: `../schemas/events.ts` (`OPS_EVENTS`, `OPS_FAMILY`, address helpers).

| File | Address | Owner |
|---|---|---|
| `ops-config.ts` | `ops-config/main` | A (backups) |
| `backup-plan.ts` | `backup-plan/<planId>` | A |
| `backup-run.ts` | `backup-run/<runId>` (virtual) | A |
| `upload.ts` | `upload/<runId>.<destId>` (virtual) | A |
| `retention.ts` | `retention/<destId>` | A |
| `restore-drill.ts` | `restore-drill/<destId>` | A |
| `telemetry-sink.ts` | `telemetry-sink/<sinkId>` | B (telemetry & self-healing) |
| `watchdog.ts` | `watchdog/main` | B |
| `condition.ts` | `condition/<id>` | B |
| `remediator.ts` | `remediator/main` | B |
