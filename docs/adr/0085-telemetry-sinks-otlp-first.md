# 85. Telemetry export: OTLP/HTTP first, native Loki push as a log sink

Date: 2026-09-28 · Status: proposed

## Context
Today `tracing.ts` POSTs traces/logs fire-and-forget to
`OTEL_EXPORTER_OTLP_ENDPOINT`. We want logs in Loki, traces in Tempo
(Grafana's trace backend, browsed in Grafana's Explore/Traces), metrics in
Prometheus/Mimir, configured in-product, with backpressure and visible loss.

Spike: `grafana/otel-lgtm` (Grafana + Loki + Tempo + Prometheus): OTLP/HTTP
JSON POSTs to `/v1/logs`, `/v1/traces`, `/v1/metrics` all returned 200 and
were queryable through Grafana's datasource proxy within ~10 s — the log
line in Loki with `service_name`, `severity_text` and attributes as
structured metadata/labels, the span in Tempo by trace id, the gauge in
Prometheus (`job = service.name`).

## Decision
- **Sink kinds**:
  - `otlp-http` (default, one sink for all signals): endpoint base URL,
    optional per-signal paths, headers (auth header value is a secret),
    protobuf (default; granary already has an encoder in `otlp-encode.ts`)
    or JSON. Covers Grafana Cloud's OTLP gateway
    (`https://otlp-gateway-<zone>.grafana.net/otlp`, Basic
    `<instanceId>:<token>`), Grafana Alloy, an OTel collector, or otel-lgtm.
  - `loki-push` (logs only): `/loki/api/v1/push` JSON, tenant header,
    Basic auth; for users with Loki but no OTLP ingest.
- **Signals**: granary traces + logs (existing Tracer output), ops' own
  traces (`service.name=granary-ops`), and a small metric set generated from
  the watchdog samples (backup age, upload failures, sink drops, outbox
  depth, disk free, alert states) as OTLP gauges every 60 s — this also lets
  users build Grafana alert rules on *absence* (second dead-man's switch).
- **Wiring**: granary's `Tracer` stops POSTing itself; it calls
  `ops.telemetrySink.write(batch)` (contract port). Ops fans out to every
  enabled sink actor. `OTEL_EXPORTER_OTLP_ENDPOINT` becomes a *seed* for an
  `otlp-http` sink (ADR 0087), so current behaviour survives.
- **Backpressure**: each sink buffers up to `maxBufferBytes` (default 8 MiB)
  and flushes every 2 s or at 512 KiB; on overflow drop **oldest** and count
  `dropped{signal, reason}`; 429/503 honour `Retry-After`; consecutive
  failures open a circuit (`open` 60 s → `half_open` probe). Telemetry is
  lossy by design — never persisted, never blocks granary.
- **Feedback loops** (ADR 0093): the sink actors' own spans are excluded from
  export; failure logs from a sink are rate-limited and not routed back into
  the failing sink.

## Consequences
One protocol to test; Grafana Cloud and self-hosted work the same. Loss is
measured and alertable instead of silent.
