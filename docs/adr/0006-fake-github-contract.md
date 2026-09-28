# 6. Fake GitHub contract

Date: 2026-09-28 · Status: accepted

## Context
The app, the `/__dev` page and the tests are built in parallel and all talk
to the fake GitHub; its surface is fixed here. All bodies are JSON validated
with TypeBox schemas shared from `src/lib/schemas/github.ts` (REST/webhook
shapes) and `fake-github/schemas.ts` (control API).

## Decision
### GitHub-compatible surface (subset, same paths/shapes as GitHub)
- `POST /repos/{owner}/{repo}/issues/{number}/comments` `{body}` → comment
- `GET  /repos/{owner}/{repo}/issues/{number}/comments` → comment[]
- `PATCH /repos/{owner}/{repo}/issues/{number}` `{state, state_reason}` → issue
- `GET /repos/{owner}/{repo}/issues/{number}` → issue
- OAuth: `GET /login/oauth/authorize?client_id&redirect_uri&state` (renders a
  "sign in as" form listing known users; `?login=<x>` auto-approves),
  `POST /login/oauth/access_token` (`Accept: application/json`),
  `GET /user` (Bearer token).
REST requires `Authorization: Bearer <GITHUB_TOKEN>` (any non-empty token in
fake mode is accepted, but its absence is 401).

### Webhooks
On issue creation the fake sends `POST $FAKE_GITHUB_WEBHOOK_URL` with headers
`X-GitHub-Event: issues`, `X-GitHub-Delivery: <uuid>`,
`X-Hub-Signature-256: sha256=<hmac of body with GITHUB_WEBHOOK_SECRET>`,
`Content-Type: application/json`, body shaped like GitHub's `issues` event
(`action`, `issue{id,number,title,body,state,state_reason,user{login,id,type},author_association,html_url}`,
`repository{id,name,full_name,owner{login}}`, `sender`).

### Control API (`/__control`, fake-only)
- `POST /__control/reset` — wipe all state.
- `POST /__control/users` `{login, type?}` — ensure a user exists.
- `POST /__control/repos` `{owner, name}` → `{id}` — ensure repo.
- `POST /__control/issues` `{owner, repo, author, title, body?, association?}`
  → `{number, deliveryId}` — create issue and deliver `issues.opened`.
- `POST /__control/issues/reopen` `{owner, repo, number, actor}` — reopens and
  delivers `issues.reopened`.
- `POST /__control/deliveries/{deliveryId}/redeliver` — resend same delivery id.
- `POST /__control/faults` `{method, pathPattern, status, count, retryAfter?}`
  — next `count` matching REST calls fail with `status`.
- `GET  /__control/state` → `{users, repos, issues:[{…, comments}], deliveries:[{id, event, action, status, responseCode}]}`
- `GET /` — a small HTML page to do the above by hand.

The fake GitHub is itself a tinyactors system (one actor per file in
`fake-github/actors/`), and exports its own traces with
`service.name=fake-github`.
