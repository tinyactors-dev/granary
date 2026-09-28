# ops telemetry (ADR 0085, 0093, 0099, 0107) — owner: B (telemetry & self-healing, M4)

Fan-out of granary's `TelemetryBatch`es to `telemetry-sink/<id>` actors,
redaction (implements `Redactor`, `../feature.ts`), sampling to the monthly
volume cap, OTLP metrics generation from watchdog samples, loop breaking.
