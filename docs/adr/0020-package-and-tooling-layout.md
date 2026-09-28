# 20. Package and tooling layout

Date: 2026-09-28 · Status: accepted

## Context
The repo started as a bare `bun init` project. ADR 0008 fixes SvelteKit on
Bun; tasks must be mise tasks and secrets must come from fnox.

## Decision
- **Package manager:** bun (`bun add`, `bun.lock`). The root `index.ts` is gone;
  the app entry is SvelteKit.
- **Dependencies split:** only what the built server must `import` at runtime
  and must not be bundled goes in `dependencies` (`@tinyactors/node`,
  `@sinclair/typebox`). Everything else (kit, svelte, vite, adapter, tailwind,
  shadcn-svelte runtime deps such as bits-ui) is a `devDependency` and is
  bundled into `build/` by Vite. See ADR 0022 for why this split matters.
- **TypeScript 6**, not 7: `@sveltejs/kit` and `svelte-check` peer on
  `^5 || ^6`, and TS 7 (native) ships no JS compiler API for svelte-check.
- `tsconfig.json` extends `.svelte-kit/tsconfig.json`, keeps the strict flags
  from `bun init`, adds `types: ["bun"]`, and includes `tests/` and
  `fake-github/` (re-listing kit's generated includes, since `include` is
  replaced, not merged).
- **Layout:** `src/lib/server/` (boot, WAL, relay, I/O processors),
  `src/lib/server/actors/` and `fake-github/actors/` (one file per actor),
  `src/lib/schemas/`, `src/lib/remote/`, `tests/`, `data/` (gitignored).
- **mise tasks** in `mise.toml`: `install`, `dev`, `fake-github`, `dev:all`
  (depends on `fake-github` and `dev`, which mise runs in parallel),
  `build`, `start`, `check`, `test` (depends on `build`), `prod`.
- **Dev env scoping:** fake dev values live in `config/dev.env` and are
  attached per task with `env = { _.file = "config/dev.env" }` on `dev`,
  `fake-github` and `start`. There is no global `[env]`, so `prod` (and any
  shell in the directory) never inherits fake credentials or localhost URLs.
- **Prod secrets:** `fnox.toml` declares `GITHUB_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_ID`,
  `GITHUB_OAUTH_CLIENT_SECRET` as 1Password references
  (`granary/<field>` in the Personal vault via the global `1password`
  provider). `mise run prod` = `fnox exec -- bun build/index.js`.

## Consequences
Test harnesses (ADR 0007) set their own env explicitly and do not rely on
mise env. The `granary` 1Password item must exist before `mise run prod`.
`fnox exec` also loads parent configs (`~/fnox.toml`), so unrelated personal
secrets are injected into the prod process too.
