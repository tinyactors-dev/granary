# 5. Processes, ports and configuration

Date: 2026-09-28 · Status: accepted · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
Processes:
1. **app** — SvelteKit on Bun (`svelte-adapter-bun`). Hosts the UI, remote
   functions, `POST /webhook`, and the tinyactors system (started from
   `hooks.server.ts` `init`). Dev: `http://localhost:5173`; built:
   `PORT` (default 3000).
2. **fake-github** — separate Bun process (`fake-github/server.ts`), its own
   tinyactors system. Default `http://localhost:4010`.
3. **OTLP collector** — in tests, started in-process by the harness.

Environment (dev/test values are fake and may live in `mise.toml` `[env]`;
production values come from fnox):

| Var | Meaning | Dev default |
|---|---|---|
| `DATABASE_PATH` | SQLite file | `./data/granary.sqlite` |
| `GITHUB_API_URL` | REST base | `https://api.github.com` (dev: `http://localhost:4010`) |
| `GITHUB_WEB_URL` | OAuth base | `https://github.com` (dev: `http://localhost:4010`) |
| `GITHUB_TOKEN` | token used by the relay | fnox (dev: `fake-token`) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret | fnox (dev: `dev-webhook-secret`) |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | UI login | fnox (dev: `fake-client` / `fake-secret`) |
| `ADMINS` | logins allowed into the UI | dev: `admin` |
| `ORIGIN` | public URL of the app | dev: `http://localhost:5173` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | where traces go (`/v1/traces` appended) | unset = no sink |
| `GRANARY_DEV` | `1` enables `/__dev` and the DAP server outside `vite dev` | unset |
| `DAP_PORT` | DAP TCP port (dev only, binds 127.0.0.1) | `4711` |
| `FAKE_GITHUB_PORT` / `FAKE_GITHUB_WEBHOOK_URL` | fake GitHub config | `4010` / `http://localhost:5173/webhook` |

`/__dev` and DAP are enabled iff `dev` (from `$app/environment`) or
`GRANARY_DEV=1`, and are always refused when `NODE_ENV=production` unless
`GRANARY_DEV=1` is also set explicitly.
