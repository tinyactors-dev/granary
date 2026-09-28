# Schemas

`@sinclair/typebox` schemas for every serialization boundary (ADR 0030).
Relative imports only (no `$lib`) — `fake-github/` imports these under plain Bun.

- `standard.ts` — `standard(schema)` Standard Schema v1 adapter for remote functions; `check`/`parse`/`parseJson`/`stringifyJson`
- `github.ts` — webhook payload, REST issue/comment/user/repo, request bodies, OAuth (ADR 0006)
- `wal.ts` — SQLite rows, JSON columns, state enums (ADR 0003)
- `actors.ts` — event names + data, issue actor data/binding/done-data, addresses (ADR 0033)
- `api.ts` / `dev.ts` — remote function and `Backend` DTOs (ADR 0031/0032)
- `config.ts` — `loadConfig(env)`, `isDevMode` (ADR 0036)
- fake GitHub control API: `fake-github/schemas.ts` (ADR 0035)
