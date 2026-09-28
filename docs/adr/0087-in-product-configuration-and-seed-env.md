# 87. Ops configuration is in-product; env vars only seed

Date: 2026-09-28 · Status: proposed

## Decision
- All ops configuration lives in `ops.sqlite` and is edited in the admin UI
  (`/ops/**`, ADR 0092): destinations, backup plans, retention, telemetry
  sinks, alert rule overrides and silences, notification channels, heartbeat.
  Every row has `origin: 'seed' | 'ui'` and `version` (optimistic
  concurrency; the UI sends the version it edited).
- **Seeds**: optional env vars create rows *only if a row with that seed id
  does not exist*; once a human edits it (`origin` becomes `ui`), seeds never
  overwrite it. Removing an env var never deletes anything. Seeded secrets go
  straight into the secret store.

| Env var | Seeds |
|---|---|
| `OPS_MASTER_KEY`, `OPS_MASTER_KEY_PREVIOUS` | not a seed: required key material (fnox, `prod` profile) |
| `OPS_DATABASE_PATH` | not a seed: default `<dataDir>/ops.sqlite` |
| `OPS_SEED_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_PREFIX`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | destination `seed:s3` |
| `OPS_SEED_BACKUP_INTERVAL` (e.g. `1h`) | plan `seed:granary` for all databases → `seed:s3` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | sink `seed:otlp` (headers become a secret) |
| `OPS_SEED_LOKI_URL`, `_TENANT`, `_USERNAME`, `_PASSWORD` | sink `seed:loki` |
| `OPS_SEED_NOTIFY_WEBHOOK_URL` | channel `seed:webhook` |
| `OPS_SEED_HEARTBEAT_URL` | heartbeat `seed:heartbeat` |

- **Defaults with nothing configured**: a `local-dir` destination under
  `<dataDir>/backups` and an hourly plan exist from first boot, so there is
  always *a* backup; the overview says loudly that it is on the same disk
  (warning until an off-site destination is verified).
- Config changes: OpsBackend writes + commits, then posts
  `config.changed {area, id}` to `ops-config/main`; actors re-read on
  `config.updated`. Invalid configs are rejected at the seam (TypeBox), and a
  destination/sink can't be enabled until one "test connection" succeeded
  with the current values.
- Import/export: the config (without secrets, with `secretRef`s) can be
  exported as JSON and imported on another instance, secrets then prompted.

## Consequences
Deploys need only the master key; everything else is clicked. Seeds make
reproducible dev/test/staging setups possible.
