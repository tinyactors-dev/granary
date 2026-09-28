# Remote functions

SvelteKit remote functions (`*.remote.ts`, `query` / `command` / `form` from
`$app/server`), validated with TypeBox via `standard()` (ADR 0030). Each one
authorizes (`requireUser` / `requireAdmin` / `requireDev`), validates, and
delegates to `getBackend()` (ADR 0032). Catalogue and refresh rules: ADR 0031.
