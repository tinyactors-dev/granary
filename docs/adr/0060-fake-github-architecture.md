# 60. Fake GitHub architecture: actors, I/O processors, faults

Date: 2026-09-28 · Status: accepted

## Context
ADR 0006 fixes the fake GitHub's surface and ADR 0035 its control schemas.
This records how `fake-github/` implements them.

## Decision
`fake-github/server.ts` is a plain `Bun.serve` (port `FAKE_GITHUB_PORT`,
default 4010; public base `FAKE_GITHUB_URL`, default
`http://localhost:$PORT`) in front of its own tinyactors `System`
(`fake-github/system.ts`). All state lives in actors, one file each in
`fake-github/actors/`:

| Address | File | Holds / does |
|---|---|---|
| `registry/main` | `registry.ts` | users (keyed case-insensitively) and repos; `user.ensure`, `user.get`, `repo.ensure`, `repo.find` |
| `repository/<repoId>` | `repository.ts` | one repo's issues and comments; builds GitHub-shaped `Issue`/`IssueComment`; `issue.create/get/update/reopen`, `comment.create/list` |
| `delivery/<deliveryId>` | `delivery.ts` | one webhook delivery: `sending → delivered \| failed`, `redeliver` → `sending` again with the same body and id |
| `faults/main` | `faults.ts` | injected REST faults with budgets; `fault.inject`, `fault.check` |
| `oauth/main` | `oauth.ts` | single-use OAuth codes (10 min) and access tokens |

The host spawns `repository/<id>` when `registry/main` reports a new repo,
and `delivery/<id>` per webhook.

I/O processors (`fake-github/io/`):
- `reply` (`reply.ts`): request/response between HTTP handlers and actors.
  `ask(system, address, event, data)` adds a `reqId`, posts, and waits; the
  chart answers with `<send type="reply">` `{reqId | reqIds, result}`
  (helper `answer(fn)`). Actor failures are results `{error, status}`
  mapped to 404 etc. by the host. `system.send(..., {until:'accepted'})`
  makes a dead letter (unknown actor) reject immediately.
- `webhook` (`webhook.ts`): POSTs the stored body to
  `FAKE_GITHUB_WEBHOOK_URL` with `X-GitHub-Event`, `X-GitHub-Delivery`,
  `X-Hub-Signature-256: sha256=HMAC(GITHUB_WEBHOOK_SECRET, exact body)`,
  10 s timeout, then posts `webhook.result {responseCode|null, error, at}`
  back to the delivery actor.

Faults: before every GitHub-compatible REST call (`/repos/{o}/{r}/issues/{n}`
and `…/comments`, after the Bearer check) the server asks `faults/main`
`fault.check {method, path}`. The first fault with `remaining > 0`, a
matching method (`*` = any) and `new RegExp(pathPattern).test(pathname)`
(unanchored) is consumed and answered with its status, body
`{"message":"injected fault"}` and `Retry-After` if set. `/__control`,
OAuth (`/login/oauth/*`) and `/user` are never faulted. An invalid RegExp
is a 400 at injection time.

Ids (`fake-github/ids.ts`): one process-wide monotonic counter seeded
from `Date.now()` for users, repos, issues and comments; **not** reset by
`/__control/reset`, because granary keys issues by numeric `repository.id`
and a re-created repo must not collide with verdicts already in the app's
database.

Other choices:
- `POST /__control/issues` and `/issues/reopen` answer after the first
  delivery attempt finished (the host registers a reply waiter before
  spawning the delivery). Redelivery resends the stored body unchanged,
  as GitHub does.
- REST accepts `Authorization: Bearer|token <t>`. An OAuth access token
  acts as its user; any other token acts as `granary[bot]` (type `Bot`),
  which becomes the author of the app's comments.
- OAuth: `client_id`/`client_secret` are checked only when
  `GITHUB_OAUTH_CLIENT_ID`/`_SECRET` are set. `access_token` accepts JSON
  or form bodies and answers JSON when `Accept` contains `json`, GitHub's
  `bad_verification_code` / `incorrect_client_credentials` otherwise.
- `/__control/reset` destroys every actor and respawns the singletons.
- `GET /__control/state` is read from the actors' live data and validated
  with `parseFakeState` before it is sent. `GET /healthz` is for readiness.
- `GET /` is a plain HTML page (no build) to open/reopen issues, inject
  faults, redeliver, reset and watch state (polls every 2 s).
- Traces: with `OTEL_EXPORTER_OTLP_ENDPOINT` set, the sink posts traces
  to `/v1/traces` and logs to `/v1/logs` (`service.name=fake-github`,
  `detail: 'decisions'`, `values: true`).

## Consequences
Every fake-GitHub state change is visible in its own traces. Handlers
are thin; adding an endpoint means adding an event to one actor.
