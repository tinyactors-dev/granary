# 175. First-run redirect and probe handling in hooks

Date: 2026-09-28 · Status: accepted · Implements 0161, 0163

## Decision
- `hooks.server.ts` sets `locals.setupState` from `Backend.getSetupStatus()`,
  cached 2 s per process. While `needs-github`, a signed-in **admin**
  requesting `GET /` is redirected (303) to `/settings/github`; everyone else
  proceeds (the settings UI shows its banner/notice).
- `/healthz` and `/readyz` bypass session lookup and redirects. `/readyz` is
  200 when granary.sqlite answers and boot marked the system ready
  (`src/lib/server/readiness.ts`), 503 otherwise; `masterKey`, `github` and
  `ops` inform only. Version comes from `package.json` (bundled).
