# 35. Fake GitHub control API schemas

Date: 2026-09-28 · Status: accepted

## Context
ADR 0006 lists the `/__control` endpoints; the response shapes and some
semantics were left open. `fake-github/schemas.ts` fixes them.

## Decision
Exports: `CONTROL_PATHS`, `ControlOk`, `ControlError`, `ResetResponse`,
`EnsureUserRequest`, `EnsureUserResponse`/`FakeUser`, `EnsureRepoRequest`,
`EnsureRepoResponse`, `FakeRepo`, `CreateIssueRequest`, `CreateIssueResponse`,
`ReopenIssueRequest`, `ReopenIssueResponse`, `RedeliverResponse`,
`FaultMethod`, `InjectFaultRequest`, `InjectFaultResponse`, `FakeFault`,
`FakeIssue`, `FakeDeliveryStatus`, `FakeDelivery`, `FakeState`/`StateResponse`,
`parseFakeState`.

| Endpoint | Request | Response |
|---|---|---|
| `POST /__control/reset` | – | `{ok: true}` |
| `POST /__control/users` | `{login, type?: 'User'\|'Bot'\|'Organization'}` | `FakeUser {login, id, type, avatarUrl}` |
| `POST /__control/repos` | `{owner, name}` | `{id}` (also ensures owner user) |
| `POST /__control/issues` | `{owner, repo, author, title, body?, association?}` | `{number, deliveryId}` |
| `POST /__control/issues/reopen` | `{owner, repo, number, actor}` | `{deliveryId}` |
| `POST /__control/deliveries/{id}/redeliver` | – | `{deliveryId, responseCode: number\|null}` |
| `POST /__control/faults` | `{method: GET\|POST\|PATCH\|PUT\|DELETE\|*, pathPattern, status: 400..599, count ≥ 1, retryAfter?}` | `{id}` |
| `GET /__control/state` | – | `FakeState {users, repos, issues: FakeIssue[], deliveries: FakeDelivery[], faults: FakeFault[]}` |

Semantics fixed here:
- `issues` ensures repo and author exist; `association` defaults `NONE`,
  `body` defaults `''`; it responds after the webhook attempt finished.
- `FakeIssue` = GitHub `Issue` fields + `{repoId, owner, repo, comments}`.
- `FakeDelivery {id, event, action, status: pending|delivered|failed,
  responseCode, repoId?, issueNumber?, attempts?, lastAttemptAt?}`, oldest first.
- Faults apply only to the GitHub-compatible REST surface (not `/__control`,
  not OAuth). `pathPattern` is a JavaScript RegExp source tested unanchored
  against the URL pathname; the failing response body is
  `{"message":"injected fault"}`, with `Retry-After: <retryAfter>` if set.
  `state.faults` shows `remaining`.
- Invalid bodies → 400 `ControlError {error, issues?}`; unknown repo / issue /
  delivery → 404 `ControlError`. Bodies are closed (unknown fields rejected).

## Consequences
The dev page (via `Backend`), the tests and the fake share one definition.
