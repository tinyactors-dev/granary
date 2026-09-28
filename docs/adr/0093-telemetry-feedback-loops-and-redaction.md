# 93. No telemetry feedback loops; redaction before export

Date: 2026-09-28 · Status: proposed

## Decision
- **Loop breaking**: the ops System's trace sink drops every span of the
  `telemetry-sink` family before it is written to the fan-out (exporting a
  batch must not create a span that must be exported). Ops' other spans are
  exported with `detail: 'summary'` (one span per macrostep), not
  `decisions`.
- Sink failure logs are rate-limited (1 / sink / minute) and tagged
  `ops.telemetry=true`; the fan-out never routes a record so tagged into the
  sink it describes, and routes it nowhere while that sink is `open`.
- Metrics are generated from watchdog samples on a timer, not per event, so
  their volume is constant.
- **Redaction** happens in the fan-out, before any sink sees a batch:
  1. exact-match replacement of every secret value currently revealed
     (registered by I/O processors, ADR 0086) and of all active secret values
     (cached hashes → candidate substrings of length ≥ 8 checked only in
     string attributes and log bodies);
  2. key-based redaction of attributes/headers named like
     `authorization|token|secret|password|api[-_]?key|cookie|set-cookie`;
  3. granary's own session ids (`granary_session`) never appear in spans
     (verified by the leak test, ADR 0091 #12).
- Ops' traces carry `service.name=granary-ops`; granary's keep `granary`.

## Consequences
Some ops internals (sink batching decisions) are not visible in Tempo; they
are visible in `/ops/telemetry` counters and the local dev span buffer.
