# ops telemetry (ADR 0085, 0093, 0099, 0107, 0121, 0122) — owner: B (telemetry & self-healing, M4)

| File | What |
|---|---|
| `fanout.ts` | `TelemetryFanout` — the `TelemetrySink` granary's Tracer writes to: redaction, sampling to the monthly volume cap, routing to `telemetry-sink/<id>` actors, delivered-volume accounting |
| `otlp-wire.ts` | OTLP protobuf wire helpers: same-length in-place masking of sensitive attribute keys, span filtering by copying raw bytes (loop breaking, sampling) |
| `redactor.ts` | `SecretRedactor` (implements `Redactor`): registered secret values masked in text and bytes |
| `sinks-repo.ts` | `telemetry_sinks` table, fingerprints for test gating |
| `seeds.ts` | `seed-otlp` from `OPS_SEED_OTLP_*` or the legacy `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `signals-out.ts` | ops' own telemetry: event log lines (OTLP/JSON) and metrics (`metricsToOTLP`) |
