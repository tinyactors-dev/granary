# 138. fake-infra dev seeds, mise task and pitchfork daemon

Date: 2026-09-28 · Status: accepted

## Decision
- `mise run fake-infra` (`bun --hot`, env from `config/dev.env`) and the
  pitchfork daemon `fake-infra` (ready on :4090), included in `mise run
  up/down/logs`.
- Dev seeds (FAKE values in `config/dev.env`), applied at start and after
  every reset: `FAKE_INFRA_SEED_BUCKET` (+ `_JURISDICTION`, default `eu`) with
  an `object-rw` key from `FAKE_INFRA_SEED_ACCESS_KEY_ID` /
  `_SECRET_ACCESS_KEY`, and an exe.dev VM token `FAKE_INFRA_SEED_EXE_TOKEN`.
  Tests run the fake without seeds for a clean slate.
- To point ops at it: `OPS_SEED_S3_ENDPOINT=http://localhost:4090/s3/eu`,
  region `auto`, the seeded bucket/keys; telemetry to the peer front
  `http://localhost:4092` with `OPS_SEED_OTLP_AUTH=exe-peer` (the dev portal
  shows a copyable snippet). An R2-kind destination needs an endpoint
  override (or Host routing) to reach the fake — that is ops' call (A/B).
