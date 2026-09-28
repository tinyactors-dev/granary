# 75. Fake GitHub: event stream, user comments, raw deliveries

Date: 2026-09-28 · Status: accepted (extends ADR 6 / 35 additively)

## Decision
- **Event stream**: the fake keeps an in-memory, sequence-numbered log
  (last 20 000) of what happened: `issue.opened`, `issue.closed` (with
  the acting login and state_reason), `issue.reopened`, `comment.created`
  (with author and body), `delivery` (id, event, action, responseCode,
  attempt). `GET /__control/events?since=<seq>` streams them as SSE
  (`data: <FakeEvent JSON>`, `id: <seq>`), replaying everything after
  `since` first; `GET /__control/events/log?since=&limit=` returns a page
  as JSON. Close/reopen events are only emitted on actual transitions.
- `POST /__control/issues/comment {owner, repo, number, author, body}`
  creates a comment as `author` and delivers `issue_comment`/`created`.
- `POST /__control/deliveries/raw {event, body, deliveryId?}` signs and
  delivers an arbitrary body with the given `X-GitHub-Event`; returns
  `{deliveryId, responseCode}`. Fake-only (fuzzing).
- Schemas: `FakeEvent`, `CreateCommentControlRequest/Response`,
  `RawDeliveryRequest/Response` in `fake-github/schemas.ts`.
