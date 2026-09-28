# 122. Telemetry sink seeds, the legacy endpoint, and test gating

Date: 2026-09-28 · Status: accepted · Implements 102 for sinks

## Decision
- One seed sink, id `seed-otlp`:
  - `OPS_SEED_OTLP_ENDPOINT` + `OPS_SEED_OTLP_AUTH` (`none` default,
    `exe-peer`, `exe-vm-token`, `bearer`, `basic` with
    `OPS_SEED_OTLP_USERNAME`); token modes reference the secret
    `seed-otlp-token`, which the backups feature's seeds create from
    `OPS_SEED_OTLP_TOKEN`. If that secret doesn't exist at boot, the sink is
    created **disabled** with a log line.
  - Otherwise the legacy `OTEL_EXPORTER_OTLP_ENDPOINT`: auth none, signals
    traces + logs, `flushIntervalMs` 1 s, and **`exportOps: false`** — the
    endpoint keeps receiving exactly granary's telemetry, as before (the
    integration tests' collector relies on this). With
    `OTEL_EXPORTER_OTLP_HEADERS` set it is created disabled (header values are
    secrets that only the UI can store).
- Seeds are enabled without a test connection (the operator asserted them),
  update their own row when the env changes, never touch a row edited in the
  UI (`origin = 'ui'`), and removing the env var deletes nothing.
- `TelemetrySinkConfig`/`Draft` gain optional `exportOps` (absent = true).
- UI-saved sinks can be **enabled only after a passed test connection** of the
  same endpoint + auth + signals (fingerprint), either within the last hour
  (drafts, incl. unsaved candidate secrets) or recorded on the row for the
  current version. `saveSink` also rejects references to secrets that don't
  exist, and checks the optimistic `version`.

## Consequences
Existing deployments keep exporting to their OTLP endpoint with no
configuration change; ops' own telemetry needs an explicit sink.
