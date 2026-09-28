# 174. CLI build, `serve` in-process, `.env` handling

Date: 2026-09-28 · Status: accepted · Implements 0156, 0159

## Decision
- `mise run cli` = `bun build src/cli/main.ts --target bun --external
  @tinyactors/node --outfile dist/cli.js` (single file, `#!/usr/bin/env bun`).
  CLI code imports only SvelteKit-free modules (`wal.ts`, `admins.ts`,
  `config-kv.ts`, `doctor.ts`, schemas, platform) via relative paths.
- `granary serve` runs the server **in-process**: it merges
  `<data>/granary.env` under the real environment, sets `GRANARY_DATA_DIR`,
  `HOST`/`PORT` from flags, `NODE_ENV=production` by default, then imports
  `<pkg>/build/index.js` (or the repo's `build/`, or `GRANARY_BUILD_DIR`).
  Signals therefore reach the server directly (no child process).
- Bun auto-loads `.env*` from the working directory before our code runs. To
  honour "never load a cwd `.env`" (ADR 0157), `serve` removes variables whose
  value equals the one in a cwd `.env*` file (unless granary.env sets the
  same value, or the data dir is the cwd) and says so. The systemd unit runs
  `bun --no-env-file <bin> serve`, which avoids the issue entirely.
- `granary init`: refuses without a terminal unless
  `--yes-i-stored-the-key`; `--json` prints `{dataDir, masterKey, …}` (the
  key only when newly generated) and requires the flag. With a key in the
  environment it writes no `master.key`.
- `granary restore` delegates to the ops restore CLI (argv rewritten,
  `--ops-db` defaulting to `<data>/ops.sqlite` in config mode) and refuses
  while a server runs; its `--help` is static text.
- Exit codes per `EXIT`: usage 2, server-not-running 3 (socket-only commands,
  or a live pid whose socket is unreachable for socket-or-direct commands).
