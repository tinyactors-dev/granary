# 150. Dev seeds point the operations module at fake-infra

Date: 2026-09-28 · Status: accepted · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Context
After M1–M4, `mise run up` started ops with only the always-on local-dir
destination; the fake R2 and the exe.dev proxy stand-in were unused in dev.

## Decision
- `config/dev.env` seeds ops against fake-infra (ADR 0130): an R2 destination
  (`OPS_SEED_R2_ACCOUNT_ID` = 32 zeros, EU jurisdiction, bucket
  `granary-backups`, keys equal to `FAKE_INFRA_SEED_*`,
  `OPS_SEED_R2_ENDPOINT_OVERRIDE=http://localhost:4090/s3/eu`) and an OTLP
  sink to the token front (`http://localhost:4091`, `exe-vm-token`, token
  `FAKE_INFRA_SEED_EXE_TOKEN`).
- A fixed, clearly labelled **dummy** `OPS_MASTER_KEY` lives in dev.env so the
  dev secret store survives deleting `data/`'s generated key file. It is
  never valid anywhere else.
- `fnox.toml` declares `OPS_MASTER_KEY` and `OPS_MASTER_KEY_PREVIOUS`
  (`if_missing = "ignore"`) in the `prod` profile (references only).
- The backups seeds also store `seed-otlp-token` from `OPS_SEED_OTLP_TOKEN`
  (kind from `OPS_SEED_OTLP_AUTH`). Because health starts before backups,
  `createOps` re-runs the sink seeds once backups has started
  (`HealthRuntime.reseedSinks`), which enables the token-auth seed sink.

## Consequences
`mise run up` gives a working ops setup: hourly backups to the fake R2 and the
local copy, drills, telemetry through the exe.dev stand-in, `/ops` with real
data.
