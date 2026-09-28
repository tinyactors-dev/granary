# 230. One naming scheme, no legacy before the first release

Date: 2026-09-28 · Status: accepted · Supersedes the naming and token-mode parts of 0003, 0005, 0006, 0034, 0036, 0040, 0041, 0060, 0061, 0086, 0102, 0118, 0122, 0150, 0157, 0160, 0161, 0172, 0180, 0193, 0194, 0203

## Context
granary grew through many parallel build passes. Each added environment
variables in its own style (`ADMINS`, `GRANARY_ADMINS`, `ALLOWED_USERS_SEED`,
`OPS_SEED_*`, `OPS_TEST_*`, `RELAY_BASE_DELAY_MS`, `DATABASE_PATH`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `GITHUB_TOKEN`, …) and kept older names as
aliases, plus a GitHub "token mode" (personal token + separate OAuth app)
that only existed so env-configured deployments and the first tests kept
working. Migrations were split across three ad-hoc tracks. granary has never
been published, so none of this history protects anybody; it only confuses.

## Decision

### Naming scheme
- Standard process variables stay unprefixed: `PORT`, `HOST`, `ORIGIN`,
  `NODE_ENV`, `HOME`, `XDG_STATE_HOME`, and svelte-adapter-bun's own
  (`PROTOCOL_HEADER`, `HOST_HEADER`, …). CI/platform variables stay as the
  platform names them (`CI`, `GITHUB_ACTIONS`, `ACTIONS_ID_TOKEN_*`), and
  the npm publish token is npm's `NPM_TOKEN`.
- Everything granary-specific is `GRANARY_*`:
  - seeds (applied once, never overwriting in-product changes) are `GRANARY_SEED_*`;
  - dev-only knobs are `GRANARY_DEV_*` (plus `GRANARY_DEV` itself) and `GRANARY_STUB_*` for UI work against stubs;
  - test-only knobs are `GRANARY_TEST_*`.
- The fakes use their own prefixes: `FAKE_GITHUB_*`, `FAKE_INFRA_*`,
  `LOADGEN_*`. The app reads a fake's URL under the fake's name
  (`FAKE_GITHUB_URL`, `FAKE_INFRA_URL`, `LOADGEN_URL`) for the /__dev tools.
- No aliases, ever, before the first release. Renames replace.

### Every variable

| Variable | Read by | Purpose |
|---|---|---|
| `PORT`, `HOST`, `ORIGIN` | app | listen address and public URL |
| `NODE_ENV` | app | `production` outside dev |
| `PROTOCOL_HEADER`, `HOST_HEADER` | app (adapter) | trust a reverse proxy's `X-Forwarded-*` |
| `HOME`, `XDG_STATE_HOME` | app, CLI | default data dir `~/.local/state/granary` |
| `GRANARY_DATA_DIR` | app, CLI | data dir: `granary.sqlite`, `ops.sqlite`, `master.key`, `granary.env`, `admin.sock` |
| `GRANARY_MASTER_KEY`, `GRANARY_MASTER_KEY_PREVIOUS` | app, CLI | master key (else `<data>/master.key`); previous key during rotation |
| `GRANARY_GITHUB_API_URL`, `GRANARY_GITHUB_WEB_URL` | app | GitHub's REST/web base (the fake in dev/tests; GitHub Enterprise) |
| `GRANARY_DEV` | app | `1` enables /__dev and the DAP server outside `vite dev` |
| `GRANARY_DAP_PORT` | app (dev) | DAP server port, default 4711 |
| `GRANARY_BUILD_DIR` | CLI | where `granary serve` finds the server bundle (default: the package's `build/`) |
| `GRANARY_RESTORE_SECRET_ACCESS_KEY` | `granary restore` | disaster recovery: bucket secret when ops.sqlite is lost |
| `GRANARY_SEED_ADMINS` | app, CLI | admin logins |
| `GRANARY_SEED_ALLOWLIST` | app | allowlisted logins |
| `GRANARY_SEED_R2_{ACCOUNT_ID,JURISDICTION,BUCKET,PREFIX,ACCESS_KEY_ID,SECRET_ACCESS_KEY,ENDPOINT_OVERRIDE,CONSOLE_URL}` | app (ops) | R2 backup destination |
| `GRANARY_SEED_S3_{ENDPOINT,REGION,BUCKET,PREFIX,ACCESS_KEY_ID,SECRET_ACCESS_KEY,CONSOLE_URL}` | app (ops), `tools/dev/s3-create-bucket.ts` | S3-compatible destination |
| `GRANARY_SEED_BACKUP_INTERVAL`, `GRANARY_SEED_EGRESS_BUDGET_GIB` | app (ops) | backup plan, egress budget |
| `GRANARY_SEED_OTLP_{ENDPOINT,AUTH,TOKEN,USERNAME,GRAFANA_URL}` | app (ops) | the seeded OTLP telemetry sink |
| `GRANARY_DEV_GITHUB_AUTOCONNECT` | app | dev/tests: connect to the fake GitHub as a GitHub App (below) |
| `GRANARY_DEV_LOGIN_HINTS` | app | dev: `origin=user:pass,…` hints in the /__dev Tools card |
| `GRANARY_STUB_BACKEND`, `GRANARY_STUB_OPS`, `GRANARY_STUB_GITHUB_MODE` | app | UI work against stub backends |
| `GRANARY_TEST_RELAY_BASE_DELAY_MS` | app | first outbox retry delay |
| `GRANARY_TEST_CATCHUP_FIRST_DELAY_MS`, `GRANARY_TEST_CATCHUP_INTERVAL_MS` | app | missed-webhook catch-up cadence |
| `GRANARY_TEST_WATCHDOG_INTERVAL_MS`, `GRANARY_TEST_GRACE_SCALE`, `GRANARY_TEST_RETRY_BASE_MS`, `GRANARY_TEST_RETENTION_INTERVAL_MS`, `GRANARY_TEST_STATFS_OVERRIDE` | app (ops) | ops timings and disk simulation |
| `GRANARY_TEST_VERBOSE` | test harness | stream subprocess output |
| `FAKE_GITHUB_PORT`, `FAKE_GITHUB_URL`, `FAKE_GITHUB_INSTALLATION_TOKEN_TTL_MS`, `FAKE_GITHUB_OTLP_ENDPOINT` | fake GitHub (URL also app, loadgen) | the fake GitHub |
| `FAKE_INFRA_PORT`, `FAKE_INFRA_URL`, `FAKE_INFRA_EXE_TOKEN_PORT`, `FAKE_INFRA_EXE_PEER_PORT`, `FAKE_INFRA_SEED_{BUCKET,JURISDICTION,ACCESS_KEY_ID,SECRET_ACCESS_KEY,EXE_TOKEN}`, `FAKE_INFRA_OTLP_ENDPOINT` | fake-infra (URL also app) | the fake R2 / OTLP / exe.dev proxy |
| `LOADGEN_PORT`, `LOADGEN_URL`, `LOADGEN_ALLOWLISTED`, `LOADGEN_GRANARY_LOGIN`, `LOADGEN_OTLP_ENDPOINT` | loadgen (URL: app) | the load generator |
| `NPM_TOKEN`, `CI`, `GITHUB_ACTIONS`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | release tooling | publishing |

### Removed
`DATABASE_PATH` and `OPS_DATABASE_PATH` (the data dir decides: `granary.sqlite`
and `ops.sqlite` live in it); `ADMINS`, `GRANARY_ADMINS` → `GRANARY_SEED_ADMINS`;
`ALLOWED_USERS_SEED` → `GRANARY_SEED_ALLOWLIST`; every `OPS_*` variable
(`OPS_MASTER_KEY*` → `GRANARY_MASTER_KEY*`, `OPS_SEED_*` → `GRANARY_SEED_*`,
`OPS_TEST_*`/`OPS_WATCHDOG_INTERVAL_MS` → `GRANARY_TEST_*`,
`OPS_RESTORE_SECRET_ACCESS_KEY` → `GRANARY_RESTORE_SECRET_ACCESS_KEY`);
`DAP_PORT`, `DEV_LOGIN_HINTS`, `RELAY_BASE_DELAY_MS`, `GRANARY_CATCHUP_*`,
`HARNESS_VERBOSE`, `GITHUB_API_URL`, `GITHUB_WEB_URL` (renamed as above);
`OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS` (telemetry goes only through
`GRANARY_SEED_OTLP_*` sinks; granary never POSTs OTLP itself; the fakes use
their own `*_OTLP_ENDPOINT`); `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, `FAKE_GITHUB_WEBHOOK_URL` (token mode is
gone); the dev master-key file is `dev-master.key` (was `ops-master.key`);
the 1Password fields are `granary/master-key(-previous)`.

### GitHub: App only
granary talks to GitHub only as a GitHub App (`github.mode` is `none` or
`app`). The personal-token + OAuth-app mode, its env seeds and its secret
refs are gone. The fake GitHub is app-only too: webhooks go only to installed
apps (no global repo webhook), REST needs an installation or user-to-server
token, and OAuth accepts only apps' clients. Repo events that no installed
app covers are not delivered (`deliveryId: null`).

Dev and tests get a connection without clicking: with
`GRANARY_DEV_GITHUB_AUTOCONNECT=1` granary runs the manifest flow
server-side against the fake (which auto-confirms), naming the app `granary`
(bot login `granary[bot]`), and turns on the fake's new per-app
**auto-install** (`POST /__control/apps/{id}/auto-install`): the app is
installed (all repos) on every account the first time one of its repos has an
event. It only acts when `<GRANARY_GITHUB_WEB_URL>/__control/state` answers —
github.com does not — and it re-checks every 15 s, reconnecting when a fake
restart forgot the app. `POST /__control/reset` takes `{keepApps: true}` so
test resets keep the app (installations, tokens and deliveries are cleared).
The test harness uses autoconnect by default and waits for `/readyz` to report
`github: ready`; setup tests use `github: 'manual'`.

### Databases: one baseline each
granary.sqlite's migrations (4 steps plus the GitHub connection's separate
schema track) and ops.sqlite's 3 steps were each squashed into one baseline
migration, and both databases carry a `PRAGMA application_id` (`gran`,
`gops`). A database with migrations applied but a different application id —
any data dir from an earlier dev build — is refused with a clear error:
recreate it (`rm -rf data/*`). Later changes append migrations as usual.

### Other history removed
The release tooling's "missing CLI" placeholder and fallback paths
(`--allow-missing-cli`, `--allow-missing`, `missing` steps), the `dev:all`
alias task, and the test harness's list of candidate CLI entry points.
`mise run test` now builds the CLI as well as the server.

## Consequences
One table above is the complete list; a new variable must fit the scheme and
be added here. Existing dev data dirs must be recreated once. Everything that
needs GitHub in dev/tests exercises the same App code path as production.
