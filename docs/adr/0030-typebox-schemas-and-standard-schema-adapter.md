# 30. TypeBox schemas and the Standard Schema adapter

Date: 2026-09-28 · Status: accepted

## Context
CLAUDE.md requires `@sinclair/typebox` at every serialization boundary, and
SvelteKit remote functions validate arguments with a Standard Schema v1
validator. `@sinclair/typebox` 0.34.52 does not implement Standard Schema
(no `~standard` property; checked in `node_modules/@sinclair/typebox/build`).

## Decision
- **Adapter** `src/lib/schemas/standard.ts`: `standard(schema)` returns
  `{ schema, '~standard': { version: 1, vendor: 'typebox', validate } }`.
  `validate` is synchronous, uses a `TypeCompiler` checker compiled lazily on
  first use and cached per schema object (WeakMap), and returns issues with
  paths as key/index segments (TypeBox JSON pointers converted; a segment is
  a number when the value at that point is an array), first message per path.
  A schema option `errorMessage: string` replaces TypeBox's message.
  The Standard Schema types are declared locally (structurally identical to
  `@standard-schema/spec` 1.x) so we depend on no transitive package.
- The same module exports `compiled`, `check`, `parse`, `parseJson`,
  `stringifyJson`, `issuesOf` and `SchemaValidationError` for non-remote
  boundaries (webhook bodies, SQLite JSON columns, GitHub responses,
  fake-GitHub control bodies). Validation never coerces, clones or applies
  defaults; defaults are applied explicitly by the caller.
- **Every remote function with an argument uses `standard(...)`** — never
  `'unchecked'`. Output DTOs are TypeScript types (not validated at runtime).
- **Schema files** (each exports TypeBox schemas, `Static` types, helpers):

  | File | Boundary |
  |---|---|
  | `src/lib/schemas/standard.ts` | adapter + generic helpers |
  | `src/lib/schemas/github.ts` | webhook payload, REST issue/comment/user/repo, request bodies, OAuth |
  | `src/lib/schemas/wal.ts` | SQLite rows, JSON columns, state enums |
  | `src/lib/schemas/actors.ts` | actor/processor events, issue actor data/binding/done-data, addresses |
  | `src/lib/schemas/api.ts` | remote function / Backend DTOs |
  | `src/lib/schemas/dev.ts` | dev remote function DTOs |
  | `src/lib/schemas/config.ts` | environment → `Config`, `isDevMode` |
  | `fake-github/schemas.ts` | fake GitHub `/__control` API |

- Schema modules use **relative imports only** (no `$lib`), so the fake
  GitHub (plain Bun, no aliases) can import `github.ts`/`standard.ts`.
  `dev.ts` imports `../../../fake-github/schemas` for the control shapes.
- Inbound GitHub objects are open (`additionalProperties: true`); request
  bodies we send, control API bodies, rows and our own DTO inputs are closed
  (`additionalProperties: false`), so unknown fields are a 400.
- Timestamps are INTEGER epoch **milliseconds** everywhere.

## Consequences
`TypeCompiler` generates code with `new Function`; this only runs on the
server (remote validators are stripped from client bundles). Invalid
remote-function input yields HTTP 400 with `{message: 'Bad Request'}` unless
`hooks.server.ts` exports `handleValidationError` (recommended: join
`issues` messages with their paths).
