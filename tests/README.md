# Tests

Integration tests only (`mise run test` = build + `bun test tests/`), run
against the built app, the fake GitHub and an in-process OTLP collector
started by `tests/harness.ts` (ADR 0061). Assert on traces
(`tests/traces.ts`, ADR 0062) and on fake-GitHub state. Scenarios: ADR 0063.
`GRANARY_TEST_VERBOSE=1` streams the subprocesses' output.

The app connects to the fake GitHub as a GitHub App by itself
(`GRANARY_DEV_GITHUB_AUTOCONNECT`, ADR 0230) and the harness waits until
`/readyz` reports `github: ready`; `useHarness({ github: 'manual' })` leaves
it unconnected for the setup scenarios.

## Load generator (`load.test.ts`, ADR 0070–0074)

`useHarness({ loadgen: true })` also starts `bun loadgen/server.ts`
(`h().loadgenUrl`, `LOADGEN_ALLOWLISTED=alice` to match the app's seed).
The test runs a short seeded mixed-persona scenario through the loadgen API
and asserts zero invariant violations, plus — through the app's traces —
that every persona issue's actor finished `allowed` or `closed` exactly as
the loadgen's policy oracle expects.
