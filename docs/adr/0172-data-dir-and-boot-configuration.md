# 172. Data dir resolution and what boot still requires

Date: 2026-09-28 · Status: accepted · Implements 0157 · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
- `resolveDataDir(env, flag)` (in `$lib/schemas/config`): `--data` >
  `GRANARY_DATA_DIR` > directory of `DATABASE_PATH` (dev/tests keep working)
  > `$XDG_STATE_HOME/granary` > `~/.local/state/granary`. `Config` gains
  `dataDir` and `host`; `databasePath` defaults to `<dataDir>/granary.sqlite`;
  ops uses `config.dataDir`.
- Nothing is required at boot any more: `REQUIRED_SECRETS` is empty and
  `loadConfig`'s `requireSecrets` option is accepted but ignored. The GitHub
  variables remain optional seeds.
- Admins come from the `admins` table; `GRANARY_ADMINS` (and `ADMINS`) seed
  it at boot and via `granary config seed`. `SessionUser.isAdmin` reads the
  table. (`/auth/callback`'s admin check still uses the env list — the GitHub
  fork owns that route and should switch it to `Backend` admins.)
- Setup state: `needs-github` until `github_settings['github.mode']` is `app`
  or `token`. Until the GitHub fork's seeds write that key, legacy env
  credentials (`GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET`) count as token mode,
  so existing deployments/tests are not sent to the wizard.
