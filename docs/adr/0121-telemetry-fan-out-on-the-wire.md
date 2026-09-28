# 121. Telemetry fan-out works on the OTLP wire format

Date: 2026-09-28 · Status: accepted · Implements 85, 93, 99, 107

## Decision
- granary's Tracer exports through `ops.telemetrySink` (`attachSink`):
  it still decodes and enriches spans (ADR 0042) and re-encodes them, then
  `write`s `{signal, contentType: protobuf, bytes, service: 'granary'}`.
  `TelemetrySink.active()` (additive) lets it skip all export work when no
  sink is enabled. `OpsHost.telemetry` (subscribe) is kept in the contract
  but unused: granary pushes, ops doesn't pull.
- The fan-out (`telemetry/fanout.ts`) never throws or blocks. Per batch:
  1. **Redaction** — registered secret values are masked byte-for-byte with
     `*` (same length, so protobuf length prefixes stay valid; JSON as text).
     Then, only if a cheap latin-1 scan of the batch matches
     `authorization|token|secret|password|api[-_]?key|cookie|granary_session`,
     a known-layout walker (`telemetry/otlp-wire.ts`) masks, in place and
     same-length, the string values of attributes with such keys (spans,
     events, links, log records, resources, scopes). A batch the walker
     can't parse is dropped, never exported unredacted. The input buffer is
     never modified (copy on write).
  2. **Sampling** — when a sink's projected monthly volume exceeds its
     `volumeBudgetBytesPerMonth`, the global ratio is lowered (×budget/
     projected ×0.9, floor 0.01; recovers ×1.25 when well under), recorded
     as a `handled` event. Granary trace batches are filtered on the wire:
     spans with status error and tinyactors lifecycle spans are always kept,
     others by a trace-id ratio decision. Nothing is re-encoded from objects.
  3. **Routing** — each enabled sink that wants the signal gets a
     `telemetry.batch` message; ops' own telemetry only goes to sinks with
     `exportOps !== false`.
- Sink actors (ADR 0082 states `idle/waiting/sending/backoff/open/half-open`)
  buffer up to `maxBufferBytes` (8 MiB) with drop-oldest and a 24 h drop log,
  flush every `flushIntervalMs` or at 512 KiB, back off 2^n s (≤ 60 s) or
  `Retry-After`, open the circuit after 5 consecutive failures and probe
  after 60 s. The `otlp` processor merges protobuf batches of one signal by
  **concatenation** (concatenated serialized messages merge their repeated
  fields), JSON batches by merging the root array, splits at 4 MiB, and
  reveals sink secrets only at the moment of the request. Delivered bytes per
  sink per month are kept in `kv` (`telemetry:volume:<sink>:<YYYY-MM>`).
- Ops-generated telemetry: ops events as OTLP/JSON log lines (Loki), a
  constant-size metric set every 60 s via tinyactors' `metricsToOTLP`
  (Prometheus). Counts and flags use unit `''` — the OTLP→Prometheus
  translation would otherwise append `_ratio` — e.g. `ops_sleep_ok`,
  `ops_condition_state{id,kind}`, `ops_backup_age_seconds`,
  `ops_telemetry_{sent,dropped,buffered,volume_month}_bytes{sink}`,
  `ops_disk_free_bytes`, `granary_outbox_dead`,
  `granary_event_loop_lag_p99_milliseconds`.

## Verification (2026-09-28)
Against `grafana/otel-lgtm` 13.2.2: granary and granary-ops traces in Tempo,
ops events in Loki (`{service_name="granary-ops"}`), metrics in Prometheus;
an `http.request.header.authorization` attribute arrived as `*****…` in
Tempo. Against fake-infra's exe.dev proxy fronts: `exe-vm-token` (good token
200, wrong token 401 "credentials rejected") and `exe-peer` both delivered.
A collector returning 503: buffer held at 8 MiB with drops counted, circuit
opened, `telemetry-sink-down` went suspect → healing (`reset-sink-circuit`)
→ attention, and cleared (info event) after the half-open probe succeeded.
