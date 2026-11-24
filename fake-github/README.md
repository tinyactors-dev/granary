# Fake GitHub

Separate Bun process emulating the subset of GitHub granary uses: GitHub
Apps (manifest flow, app JWTs, installations, installation tokens, the app
delivery log), REST (issues, comments), webhooks and OAuth for apps, plus a
`/__control` API. Contract: ADR 0006 / 0035 / 0164; architecture: ADR 0060.
It is app-only like granary (ADR 0230): webhooks go only to installed apps;
a repo event no installed app covers is not delivered.

- `POST /__control/apps/{id}/auto-install {enabled}` installs the app (all
  repos) on every account the first time one of its repos has an event —
  what granary's dev/test bootstrap (`GRANARY_DEV_GITHUB_AUTOCONNECT`) turns on.
- `POST /__control/reset {keepApps?}` keeps registered apps (and their
  auto-install flag) when `keepApps` is true; the test client always sends it.

```sh
mise run fake-github          # http://localhost:4010 (config/dev.env)
open http://localhost:4010/   # open/reopen issues, faults, redeliver, state
```

Layout: `server.ts` (HTTP), `system.ts` (tinyactors host, reset,
snapshot), `actors/` (one actor per file: registry, repository, delivery,
faults, oauth, apps; the host asks them with `askActor`), `io/` (the `webhook` I/O processor), `app-*.ts` (GitHub App routes, crypto, pages), `views.ts`,
`page.ts`, `ids.ts`, `schemas.ts` (control API).

## Changes made through the REST API, deleted issues, lost responses (ADR 0313)

- A `PATCH` that changes an issue's or pull request's state delivers
  `issues` / `pull_request` `closed` or `reopened` to the installed apps,
  with the caller (an app's bot) as `sender`, as GitHub does for an app's
  own changes. The response does not wait for the delivery.
- `POST /__control/issues/delete {owner, repo, number, actor}` — an admin
  deletes an issue (GitHub: web UI only); delivers `issues`/`deleted`. The
  REST API then answers `410 Gone` ("This issue was deleted") and its page
  410. Pull requests cannot be deleted (422).
- `POST /__control/faults {…, applied: true}` — the request is carried out
  (webhooks included), then the fault's status is answered instead: GitHub
  made the change but the response was lost. REST only.

## Event stream, user comments, raw deliveries (ADR 0075)

- `GET /__control/events?since=<seq>` — SSE stream of `FakeEvent`s
  (`issue.opened`, `issue.closed` with `by`, `issue.reopened`, `issue.deleted`,
  `pull_request.opened|closed|reopened`,
  `comment.created`, `delivery` with `responseCode`); replays after `since`.
- `GET /__control/events/log?since=&limit=` — the same as a JSON page.
- `POST /__control/issues/comment {owner, repo, number, author, body}` —
  comment as a user; delivers `issue_comment`/`created`.
- `POST /__control/deliveries/raw {event, body, action?, deliveryId?}` —
  sign and deliver an arbitrary body to the newest app (fuzzing).

The load generator (`loadgen/`) is the main consumer.
