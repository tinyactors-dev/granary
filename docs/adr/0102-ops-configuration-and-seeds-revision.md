# 102. Ops configuration and seeds, revised for R2 and exe.dev

Date: 2026-09-28 · Status: proposed · Supersedes 87 · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
Everything is still configured in-product (ops.sqlite, `origin: seed|ui`,
optimistic `version`, seeds never overwrite UI edits, removing an env var
deletes nothing, export/import without secrets). Changes:

| Env var | Seeds / meaning |
|---|---|
| `OPS_MASTER_KEY`, `OPS_MASTER_KEY_PREVIOUS` | required key material (fnox `prod` profile); not a seed |
| `OPS_DATABASE_PATH` | default `<dataDir>/ops.sqlite`; not a seed |
| `OPS_SEED_R2_ACCOUNT_ID`, `_BUCKET`, `_PREFIX`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | destination `seed:r2` (kind `r2`) |
| `OPS_SEED_S3_*` (endpoint, region, bucket, prefix, keys) | destination `seed:s3` — generic; used for fake-infra in dev/tests |
| `OPS_SEED_BACKUP_INTERVAL` | plan `seed:all` (default `1h`) |
| `OPS_SEED_OTLP_ENDPOINT`, `OPS_SEED_OTLP_AUTH` (`exe-peer`\|`exe-vm-token`\|`none`\|`bearer`\|`basic`), `OPS_SEED_OTLP_TOKEN` | sink `seed:otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | legacy: seed `seed:otlp` if `OPS_SEED_OTLP_*` is absent |
| `OPS_SEED_EGRESS_BUDGET_GIB` | backup/telemetry egress budgets (ADR 0098) |

Removed: `OPS_SEED_NOTIFY_WEBHOOK_URL`, `OPS_SEED_HEARTBEAT_URL`,
`OPS_SEED_LOKI_*`.

Schema invariants (TypeBox, enforced at the seam): no encryption toggle
(ADR 0097); `storageClass` absent (ADR 0096); `maxBytes`/`maxBackups`
required with upper bounds; a destination or sink can't be enabled until its
test connection passed with the current values.

Default with nothing configured: a `local-dir` destination (1 copy, ADR 0098)
and an hourly plan, plus an *attention* item "no off-site destination" —
the only attention item that is expected on a fresh install.
