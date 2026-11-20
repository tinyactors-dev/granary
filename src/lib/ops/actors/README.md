# ops actors — one file per actor (ADR 0082, 0101)

Each file exports its chart as SCXML built with `src/lib/charts` (ADR 0300); logic is embedded helper functions. Actor names on the ops host (`granary-ops`) are `<family>/<name>`; the chart is the family.

Message catalogue and addresses: `../schemas/events.ts` (`OPS_EVENTS`, `OPS_FAMILY`, address helpers).

| File | Address | Owner |
|---|---|---|
| `ops-config.ts` | `ops-config/main` | A (backups) |
| `backup-plan.ts` | `backup-plan/<planId>` | A |
| `backup-run.ts` | `backup-run/<runId>` (virtual: spawned from its row by `ops-route` or at boot) | A |
| `upload.ts` | `upload/<runId>.<destId>` (virtual: spawned from its row by `ops-route` or at boot) | A |
| `retention.ts` | `retention/<destId>` | A |
| `restore-drill.ts` | `restore-drill/<destId>` | A |
| `telemetry-sink.ts` | `telemetry-sink/<sinkId>` | B (telemetry & self-healing) |
| `watchdog.ts` | `watchdog/main` | B |
| `condition.ts` | `condition/<id>` | B |
| `remediator.ts` | `remediator/main` | B |
