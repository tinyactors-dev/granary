# 7. Tests run against a running system and assert on traces

Date: 2026-09-28 · Status: accepted

## Decision
- No unit tests. `bun test tests/` runs integration tests only.
- `tests/harness.ts` starts: an in-process OTLP/HTTP collector
  (`Bun.serve`, `POST /v1/traces`, decoded with `decodeTraces`), the
  fake GitHub, and the **built** app (`bun build/index.js`) with a temp
  `DATABASE_PATH`, `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the collector,
  and fake credentials. Ports are picked free per run.
- Tests drive the system only through its external surfaces (fake GitHub
  control API, webhooks, HTTP) and assert on (a) spans from the collector —
  e.g. the `issue/<key>` actor reaching final state `closed` — and (b) the
  fake GitHub's observable state.
- The app's trace sink uses `resource: {"service.name": "granary"}`,
  `detail: "decisions"`, `values: true`, so state entries and event names
  appear in spans.
- The harness exposes `waitForSpan(predicate, timeout)` and `spans()`.
- Crash/restart tests kill the app process (SIGKILL) and restart it against
  the same DB.
