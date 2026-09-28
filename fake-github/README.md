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

Layout: `server.ts` (HTTP), `system.ts` (tinyactors System, reset,
snapshot), `actors/` (one actor per file: registry, repository, delivery,
faults, oauth, apps), `io/` (`reply`, `webhook` I/O processors), `app-*.ts` (GitHub App routes, crypto, pages), `views.ts`,
`page.ts`, `ids.ts`, `schemas.ts` (control API).

## Event stream, user comments, raw deliveries (ADR 0075)

- `GET /__control/events?since=<seq>` — SSE stream of `FakeEvent`s
  (`issue.opened`, `issue.closed` with `by`, `issue.reopened`,
  `comment.created`, `delivery` with `responseCode`); replays after `since`.
- `GET /__control/events/log?since=&limit=` — the same as a JSON page.
- `POST /__control/issues/comment {owner, repo, number, author, body}` —
  comment as a user; delivers `issue_comment`/`created`.
- `POST /__control/deliveries/raw {event, body, action?, deliveryId?}` —
  sign and deliver an arbitrary body to the newest app (fuzzing).

The load generator (`loadgen/`) is the main consumer.
