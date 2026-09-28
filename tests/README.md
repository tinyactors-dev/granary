# Tests

Integration tests only (`mise run test` = build + `bun test tests/`), run
against the built app, the fake GitHub and an in-process OTLP collector
started by `tests/harness.ts` (ADR 0061). Assert on traces
(`tests/traces.ts`, ADR 0062) and on fake-GitHub state. Scenarios: ADR 0063.
`HARNESS_VERBOSE=1` streams the subprocesses' output.
