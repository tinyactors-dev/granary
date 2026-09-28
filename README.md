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
| `mise run up` / `down` / `logs` | dev daemons via pitchfork (fake GitHub, fake-infra, loadgen, app) |
| `mise run load:run -- --preset chaos --seed 7` | headless load scenario against the running stack; exit 1 on invariant violations |
| `mise run build` | production build into `build/` (svelte-adapter-bun) |
| `mise run start` | run `build/` against the fake GitHub (dev env, port 3000) |
| `mise run check` | `svelte-kit sync` + `svelte-check` |
| `mise run test` | build, then `bun test tests/` (integration tests, ADR 0007) |
| `mise run prod` | `fnox exec -P prod -- bun build/index.js` (real secrets from 1Password, `prod` profile) |
| `mise run deploy -- --host <ssh-host> [--dry-run]` | pack HEAD, install on a host, restart, wait for `/healthz` (ADR 0233) |
| `mise run release -- --channel dev\|latest [--yes]` | pack → verify → publish to npm (dry run without `--yes`; ADR 0186) |

Typical dev loop: `mise run install && mise run up`, then open
http://localhost:5173. In development, http://localhost:5173/__dev is the
developer console (the sidebar switches to it): sessions, fake GitHub, the
load tester and its personas (`/__dev/load`), traces, actors & debugger, and
component previews (`/__dev/ui`).

## Configuration

- Every environment variable is listed in ADR 0230 (one naming scheme:
  standard ones like `ORIGIN`/`PORT` unprefixed, everything else
  `GRANARY_*`, seeds `GRANARY_SEED_*`, dev-only `GRANARY_DEV_*`, test-only
  `GRANARY_TEST_*`; the fakes use `FAKE_GITHUB_*`, `FAKE_INFRA_*`, `LOADGEN_*`).
- Dev defaults (fake values only) live in `config/dev.env` and are attached
  to the dev tasks — not globally, so `prod` never sees them. In dev granary
  connects to the fake GitHub as a GitHub App by itself
  (`GRANARY_DEV_GITHUB_AUTOCONNECT=1`).
- Production: the only secret is `GRANARY_MASTER_KEY`, declared in
  `fnox.toml` (profile `prod`) as a 1Password reference. The GitHub App,
  admins, allowlist, backup destinations and telemetry sinks are configured
  in the product (the manual in `docs/manual/`).
- The data directory (`GRANARY_DATA_DIR`) holds `granary.sqlite` and
  `ops.sqlite`. Before the first release their schemas were squashed into
  one baseline each; a data directory from an earlier dev build is refused —
  `rm -rf data/*` (ADR 0230).
- Deploying `build/` needs the production `node_modules` next to it
  (`bun install --production`): runtime `dependencies` such as the native
  `@tinyactors/node` addon are not bundled (ADR 0022).

## Deploying and releasing

The operator manual is [`docs/manual/`](docs/manual/README.md); day-2 tasks are
in its [operations runbook](docs/manual/operations-runbook.md). Production
(ADR 0231): `https://granary.tinyactors.dev` on the exe.dev VM `ta-granary`,
telemetry to the shared `ta-metrics` Grafana.

- **Deploy** a commit: `mise run deploy -- --host ta-granary.exe.xyz`
  (clean tree; `--dry-run` first; `--tarball`/`--npm` to install something
  else, e.g. to roll back).
- **Publish to npm** (`@tinyactors/granary`): the manually triggered GitHub
  Actions workflow **release** (inputs `channel` = `dev`/`latest`,
  `dry_run`) runs `tools/release/release.ts` and publishes with provenance via
  npm trusted publishing. Setup on npmjs.com → the package → *Settings* →
  *Trusted Publisher* → GitHub Actions: organization `tinyactors-dev`,
  repository `granary`, workflow `release.yml`, no environment (the workflow
  uses none). npm's trusted-publisher settings live on the package's page, so
  the **very first publish** needs a token: either from the laptop
  (`mise run release -- --channel latest --yes --accept-unverified linux/amd64`,
  token from fnox's `release` profile, 1Password `granary/npm-token`, no
  provenance) or once in CI with a temporary `NPM_TOKEN` repository secret;
  then add the trusted publisher and delete the token.
- **First release** must be the stable `0.1.0` (npm tags a new package's first
  version `latest` regardless of `--tag`): date its `CHANGELOG.md` entry, tag
  `v0.1.0`, push the tag, run the workflow with `channel=latest` and
  `dry_run=true`, then again with `dry_run=false`. Afterwards `dev` builds
  (`0.1.0-dev.<epoch>.g<sha>` → dist-tag `dev`) can go out any time.

## Layout

```
src/
  app.html, app.css, app.d.ts
  hooks.server.ts            # boots the backend (actor system, ops)
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
fake-github/                 # fake GitHub (GitHub Apps only) + actors/
fake-infra/                  # fake R2, OTLP receiver, exe.dev proxy stand-in
loadgen/                     # load generator: personas/ (statecharts), scenario coordinator, observer
tests/                       # integration tests (bun test)
data/                        # SQLite files (gitignored)
config/dev.env, real.env     # fake dev env; real local ops stack overlay
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
