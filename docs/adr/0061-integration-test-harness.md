# 61. Integration test harness

Date: 2026-09-28 · Status: accepted

## Context
ADR 0007 requires tests against a running system observed through
traces. This records the harness design (`tests/harness.ts`).

## Decision
`useHarness(options?)` registers `beforeAll`/`afterAll` and returns a
getter for one `Harness` per test file. `Harness.start()`:
1. starts the in-process OTLP collector (`tests/otlp.ts`, `Bun.serve` on
   a random port): `POST /v1/traces` decoded with `decodeTraces`,
   `POST /v1/logs` with a small protobuf decoder (tinyactors has none) to
   read `tinyactors.definition.registered` records, `/v1/metrics` ignored;
2. spawns `bun fake-github/server.ts` and waits for `GET /healthz`;
3. spawns the built app `bun build/index.js` (fails fast if
   `build/index.js` is missing — `mise run test` depends on `build`) and
   waits for any non-5xx answer on `GET /auth/login`.

Ports come from binding port 0; every URL uses `127.0.0.1`. App env:
`NODE_ENV=production`, `PORT`, `HOST=127.0.0.1`, `ORIGIN`, temp
`DATABASE_PATH`, `GITHUB_API_URL`/`GITHUB_WEB_URL`/`FAKE_GITHUB_URL` = the
fake, fake `GITHUB_TOKEN`/`GITHUB_WEBHOOK_SECRET`/OAuth client,
`ADMINS=admin`, `ALLOWED_USERS_SEED=alice`,
`OTEL_EXPORTER_OTLP_ENDPOINT` = collector. Inherited `GRANARY_*`,
`GITHUB_*`, `OTEL_*` etc. are stripped, so `GRANARY_DEV` is unset.
The fake gets `FAKE_GITHUB_WEBHOOK_URL=<app>/webhook` and the same secrets.

Every span is tagged with `service` (`service.name`), `epoch` and arrival
`seq`. `restartApp({kill})` kills the app (default SIGKILL), bumps the
app's epoch, and starts it again on the same port and database: a new
process restarts tinyactors session ids, so sessions are keyed by
`(service, epoch, session_id)`.

API: `spans()`, `index()` (a `TraceIndex`, ADR 0062),
`spansMatching(pred)`, `waitForSpan(pred, {timeout})`, `waitFor(fn,
{timeout, interval, message})` (polls until truthy; timeouts include the
actor-session summary and the tail of both processes' output),
`fakeGithub` (`FakeGithubClient`, typed by `fake-github/schemas.ts`,
responses validated), `fetchApp`, `postWebhook(body, {signature})`,
`restartApp`, `killApp`, `stop()`, `appUrl`, `fakeUrl`, `databasePath`.
`HARNESS_VERBOSE=1` streams subprocess output live.

## Consequences
One app + fake per test file (a few hundred ms each). Tests reset the
fake GitHub in `beforeEach` and use unique repo names; the app database
is shared within a file, which is safe because repo ids never repeat
(ADR 0060).
