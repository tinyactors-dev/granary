# 31. Remote function catalogue and authorization rules

Date: 2026-09-28 · Status: accepted

## Context
The UI talks to the server only through SvelteKit remote functions
(ADR 0008/0023). The UI agent and the backend agent work in parallel, so the
full list, the input/output types and who may call what are fixed here.

## Decision
Remote functions live in `src/lib/remote/*.remote.ts`. Each one: (1) checks
authorization synchronously first, (2) validates input with `standard(...)`
(ADR 0030), (3) delegates to `getBackend()` (ADR 0032) through
`withBackend()` which maps `BackendError` codes to HTTP statuses
(not-found 404, conflict 409, invalid 400, upstream 502, unavailable 503).

Authorization (`src/lib/server/auth.ts`, reading `getRequestEvent().locals`):
- `requireUser()` → 401 when `locals.user` is null.
- `requireAdmin()` → 401 / 403 unless `locals.user.isAdmin`.
- `requireDev()` → **404** unless `locals.devMode` (dev surfaces pretend not to exist).
- `App.Locals = { user: SessionUser | null; sessionId: string | null; devMode: boolean }`,
  set by `hooks.server.ts` on every request.

Reads need a user; mutations need an admin; dev functions need dev mode only
(no user — `/__dev` is where you log in).

| File | Name | Kind | Input | Output | Auth |
|---|---|---|---|---|---|
| session | `getCurrentUser` | query | – | `SessionUser \| null` | public |
| session | `logout` | command | – | `{ok: true}` | public |
| dashboard | `getOverview` | query | – | `Overview` | user |
| dashboard | `listDeliveries` | query | `ListDeliveriesInput` | `Page<DeliverySummary>` | user |
| dashboard | `listEffects` | query | `ListEffectsInput` | `Page<EffectSummary>` | user |
| dashboard | `listVerdicts` | query | `ListVerdictsInput` | `Page<VerdictSummary>` | user |
| dashboard | `getIssue` | query | `GetIssueInput` | `IssueDetail \| null` | user |
| allowlist | `listAllowedUsers` | query | – | `AllowedUser[]` | user |
| allowlist | `addAllowedUser` | form | `AddAllowedUserInput` | `AddAllowedUserResult` | admin |
| allowlist | `removeAllowedUser` | command | `RemoveAllowedUserInput` | `RemoveAllowedUserResult` | admin |
| effects | `retryEffect` | command | `RetryEffectInput` | `EffectSummary` | admin |
| actors | `listActors` | query | – | `ActorSummary[]` | user |
| dev | `getDevInfo` | query | – | `DevInfo` | dev |
| dev | `devLoginAs` | form | `DevLoginAsInput` | redirect 303 | dev |
| dev | `devOpenIssue` | form | `DevOpenIssueInput` | `DevOpenIssueResult` | dev |
| dev | `devReopenIssue` | command | `DevReopenIssueInput` | `DevReopenIssueResult` | dev |
| dev | `devRedeliver` | command | `DevRedeliverInput` | `DevRedeliverResult` | dev |
| dev | `devInjectFault` | form | `DevInjectFaultInput` | `DevInjectFaultResult` | dev |
| dev | `devReset` | command | – | `{ok: true}` | dev |
| dev | `devSendEvent` | command | `DevSendEventInput` | `DevSendEventResult` | dev |
| dev | `getRecentSpans` | query | `GetRecentSpansInput` | `SpanSummary[]` | dev |
| dev | `getDapLaunchConfig` | query | `GetDapLaunchConfigInput` | `DapLaunchConfig` | dev |

Paging: list queries take `{limit?: 1..200 (default 50), before?: cursor}`
plus a filter, and return `{items, nextCursor}`; pass `nextCursor` back as
`before`. Queries with an object input need at least `{}`.

Refresh rules (single-flight mutations):
- `addAllowedUser`, `removeAllowedUser` refresh `listAllowedUsers()` and `getOverview()`.
- `retryEffect` refreshes `getOverview()` plus the `listEffects(...)` and
  `getIssue(...)` instances the client names with `.updates(...)` (`requested()`).
- `devOpenIssue` refreshes `getDevInfo()`, `getOverview()` and requested `listDeliveries(...)`;
  `devReopenIssue`/`devRedeliver` refresh `getDevInfo()`, `getOverview()`;
  `devInjectFault`/`devReset` refresh `getDevInfo()`;
  `devSendEvent` refreshes `listActors()` and requested `getIssue(...)`.
- `logout` sets `getCurrentUser()` to null. Commands cannot redirect, so the
  UI calls `goto('/')` after `logout()`. `devLoginAs` redirects (303) to
  `redirectTo` (same-origin path, default `/`).
- Forms: a backend `invalid`/`conflict` on `addAllowedUser` becomes a field
  issue on `login`; an `upstream`/`invalid` error on `devOpenIssue` becomes
  a form-level issue.

## Consequences
Queries cannot set cookies; session creation/removal happens in forms,
commands and `+server.ts` routes only. Live data is refreshed by the UI
(`.refresh()` / polling); `query.live` is not used yet.
