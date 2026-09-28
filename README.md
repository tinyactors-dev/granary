# granary

granary listens to GitHub `issues` webhooks and auto-closes issues opened by
users who are not on an allowlist. SvelteKit (Svelte 5) on Bun, actors on
[`@tinyactors/node`](node_modules/@tinyactors/node/README.md), SQLite
write-ahead log via `bun:sqlite`. Decisions: [`docs/adr/`](docs/adr/).

## Running

All tasks are [mise](https://mise.jdx.dev) tasks (`mise tasks ls`):

| Task | What it does |
|---|---|
| `mise run install` | `bun install` |
| `mise run dev` | SvelteKit dev server on Bun, http://localhost:5173 (dev env) |
| `mise run fake-github` | fake GitHub on http://localhost:4010 (dev env) |
| `mise run loadgen` | load generator / persona simulator on http://localhost:4040 (ADR 0070) |
| `mise run up` / `down` / `logs` | dev daemons via pitchfork (fake GitHub, app, loadgen); `dev:all` = `up` |
| `mise run load:run -- --preset chaos --seed 7` | headless load scenario against the running stack; exit 1 on invariant violations |
| `mise run build` | production build into `build/` (svelte-adapter-bun) |
| `mise run start` | run `build/` against the fake GitHub (dev env, port 3000) |
| `mise run check` | `svelte-kit sync` + `svelte-check` |
| `mise run test` | build, then `bun test tests/` (integration tests, ADR 0007) |
| `mise run prod` | `fnox exec -P prod -- bun build/index.js` (real secrets from 1Password, `prod` profile) |

Typical dev loop: `mise run install && mise run up`, then open
http://localhost:5173. In development, http://localhost:5173/__dev is the
developer console (the sidebar switches to it): sessions, fake GitHub, the
load tester and its personas (`/__dev/load`), traces, actors & debugger, and
component previews (`/__dev/ui`).

## Configuration

- Dev/test defaults (fake values only) live in `config/dev.env` and are
  attached to the `dev`, `fake-github` and `start` tasks — not globally, so
  `prod` never sees them. See ADR 0005 for every variable.
- Production secrets (`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`) are declared in
  `fnox.toml` as 1Password references (item `granary`). Non-secret prod
  settings (`ORIGIN`, `PORT`, `DATABASE_PATH`, `ADMINS`, `GITHUB_API_URL`, …)
  come from the process environment.
- Deploying `build/` needs the production `node_modules` next to it
  (`bun install --production`): runtime `dependencies` such as the native
  `@tinyactors/node` addon are not bundled (ADR 0022).

## Layout

```
src/
  app.html, app.css, app.d.ts
  hooks.server.ts            # (to come) boots the actor system
  routes/                    # pages, /webhook, /__dev
  lib/
    components/ui/           # shadcn-svelte components
    utils.ts                 # cn() etc.
    schemas/                 # TypeBox schemas (all serialization boundaries)
    remote/                  # SvelteKit remote functions (*.remote.ts)
    dev-ui/                  # component preview registry (/__dev/ui)
    trace/                   # browser-safe trace summaries and fixtures
    server/                  # system boot, WAL, relay, I/O processors
      actors/                # one file per actor (main system)
fake-github/                 # fake GitHub server + actors/
loadgen/                     # load generator: personas/ (statecharts), scenario coordinator, observer
tests/                       # integration tests (bun test)
data/                        # SQLite files (gitignored)
config/dev.env               # fake dev/test env
docs/adr/                    # architecture decision records
```

Adding UI components: `bunx shadcn-svelte@latest add <name>`.

## Real local ops stack (RustFS + Grafana)

`mise run up:real` runs the app against real ops targets instead of only the
fakes (ADR 0027; needs docker via colima):

| What | URL |
|---|---|
| granary (dev, `data/real/`) | http://localhost:5173 → `/ops` |
| RustFS console (S3 backups) | http://localhost:9001/rustfs/console/ — `granary-dev` / `granary-dev-secret` |
| Grafana (Loki, Tempo, Prometheus) | http://localhost:3300 — `admin` / `admin` |

Backups run every 10 minutes to RustFS (and to fake-infra's R2 and a local
copy); granary's and ops' traces, logs and metrics go to Grafana.
`mise run up` switches back to the plain dev stack; `mise run down:real` stops
everything; `mise run logs:real` tails the real-stack daemons.
