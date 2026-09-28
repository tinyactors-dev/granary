# 70. The load generator is a separate process with its own actor system

Date: 2026-09-28 · Status: accepted

## Context
We want to drive granary with realistic, reproducible activity (many users,
bursts, hostile input, infrastructure faults) and observe whether it keeps
its promises. Granary must see exactly what it sees in production: signed
webhooks and REST traffic, nothing else.

## Decision
- `loadgen/` is a third process (Bun.serve on `LOADGEN_PORT`, default
  4040) next to the app and the fake GitHub. It owns one tinyactors
  `System`; every actor file lives in `loadgen/personas/` (one file per
  persona kind) or `loadgen/actors/` (the scenario coordinator).
- Loadgen **only acts on the fake GitHub** (its `/__control` API) and only
  **observes the fake GitHub** (its event stream and state). It never calls
  granary, never reads granary's DB and never sees granary's traces. It is
  therefore a black-box oracle: the same tool could drive a staging
  granary against the fake.
- The engine is a library (`loadgen/engine.ts`, `createLoadgen(config)`)
  used by two front ends: the HTTP server (`loadgen/server.ts`, what the
  dev portal talks to) and the headless CLI (`loadgen/cli.ts`,
  `mise run load:run`), which runs one scenario in-process, prints a
  summary and exits non-zero on invariant violations.
- Configuration (env): `LOADGEN_PORT`, `FAKE_GITHUB_URL` (default
  `http://localhost:4010`), `LOADGEN_ALLOWLISTED` (logins granary is
  expected to allow — must match granary's `ALLOWED_USERS_SEED`),
  `LOADGEN_GRANARY_LOGIN` (who granary acts as on the fake, default
  `granary[bot]`), `OTEL_EXPORTER_OTLP_ENDPOINT` (traces with
  `service.name=loadgen`).
- Each scenario works in its own repository `loadgen/<scenario-id>` on the
  fake, so runs never interfere with each other or with manual testing, and
  injected faults are scoped to that repository's paths.

## Consequences
Three processes in dev (`mise run dev:all` starts all). Loadgen's view of
"allowed" comes from its own config, so `LOADGEN_ALLOWLISTED` and granary's
allowlist must agree; changing the allowlist in the UI during a run can
produce false violations.
