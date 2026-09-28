# Fake GitHub

Separate Bun process emulating the subset of GitHub granary uses: REST
(issues, comments), webhooks, OAuth, plus a `/__control` API. Contract:
ADR 0006 / 0035; architecture: ADR 0060.

```sh
mise run fake-github          # http://localhost:4010 (config/dev.env)
open http://localhost:4010/   # open/reopen issues, faults, redeliver, state
```

Layout: `server.ts` (HTTP), `system.ts` (tinyactors System, reset,
snapshot), `actors/` (one actor per file: registry, repository, delivery,
faults, oauth), `io/` (`reply`, `webhook` I/O processors), `views.ts`,
`page.ts`, `ids.ts`, `schemas.ts` (control API).

## Event stream, user comments, raw deliveries (ADR 0075)

- `GET /__control/events?since=<seq>` — SSE stream of `FakeEvent`s
  (`issue.opened`, `issue.closed` with `by`, `issue.reopened`,
  `comment.created`, `delivery` with `responseCode`); replays after `since`.
- `GET /__control/events/log?since=&limit=` — the same as a JSON page.
- `POST /__control/issues/comment {owner, repo, number, author, body}` —
  comment as a user; delivers `issue_comment`/`created`.
- `POST /__control/deliveries/raw {event, body, action?, deliveryId?}` —
  sign and deliver an arbitrary body (fuzzing).

The load generator (`loadgen/`) is the main consumer.
