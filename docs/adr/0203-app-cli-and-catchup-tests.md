# 203. Tests for the GitHub App, catch-up and the CLI

Date: 2026-09-28 · Status: accepted · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Decision
- `tests/github-app-fake.test.ts` pins the fake's App surface as a contract
  (manifest flow, JWT rules, installations, token scope/expiry, delivery log,
  outage, redelivery, app OAuth). It runs today and is what granary's app
  backend can rely on.
- `tests/github-app.test.ts`, `tests/catchup.test.ts`, `tests/cli.test.ts`
  exercise granary itself through its external surfaces: the `granary` CLI
  (`dist/cli.js`, else `src/cli/{main,index}.ts`), login links, the
  `/settings/github` manifest form, the fake's control API and traces. Each
  file has a `LIVE` switch; while false no harness starts and the scenarios
  are `todo` (the current build still requires GitHub env). They go live
  when E1/E3/E5 are in `build/`.
- Harness additions (additive): `GRANARY_DATA_DIR` = the test tmp dir,
  `extraAppEnv` (set from `prepare`, e.g. the key printed by `granary init`),
  `cliEntry()` / `runCli(h, args)` (always passes `--data`),
  `FakeGithubClient.installApp` / `webhookOutage`; helpers in
  `tests/github-app.ts` (`appJwt`, `createAppOnFake`, `consumeLoginLink`,
  `setupGitHubApp`, `setupAppMode`, `APP_MODE_ENV`).
- **Assumed knobs** the implementation must provide for these tests:
  `GRANARY_CATCHUP_FIRST_DELAY_MS` and `GRANARY_CATCHUP_INTERVAL_MS`
  (catch-up timing, ADR 0162); `granary github status --json` returning
  `{ mode, app: { slug }, installations: [{ account }] }`; `granary init
  --json` printing the 64-hex master key; `login-link --json` returning
  `CreatedLoginLink`; `/settings/github` rendering a `<form action=…/settings/apps/new…>`
  with a hidden `manifest` input server-side. Deviations are fixed in the
  tests during integration (E6).
