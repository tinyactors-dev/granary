# 41. Outbox relay behaviour and its observable effects

Date: 2026-09-28 · Status: accepted

## Context
ADR 0003 fixes the outbox rules; the retry schedule, concurrency and the
exact REST calls are needed by tests that count calls on the fake GitHub.

## Decision
`Relay` (`src/lib/server/relay.ts`), plain async TypeScript:

- **Claim:** in one transaction, up to `concurrency` (4) minus running rows
  with `state='pending' AND next_attempt_at <= now` become `inflight` with
  `attempts = attempts + 1`, committed before any HTTP call. Kicked by the
  `github` processor, by finished effects, and by a timer at the earliest
  `next_attempt_at`. At boot, `inflight` rows go back to `pending` (due now).
- **Per effect** (`close:<repoId>:<number>`), with `Authorization: Bearer
  $GITHUB_TOKEN`, against `GITHUB_API_URL`, responses validated with
  `$lib/schemas/github`:
  1. `comment_id` null and this is a retry (`attempts > 1` after the claim):
     `GET /repos/{o}/{r}/issues/{n}/comments?per_page=100&page=N` and adopt a
     comment whose body contains `<!-- granary:<effect_key> -->`.
  2. still null: `POST …/comments` with `CLOSING_COMMENT + "\n\n" + marker`;
     store `comment_id` immediately.
  3. `PATCH /repos/{o}/{r}/issues/{n}` `{"state":"closed","state_reason":"not_planned"}`.
  4. row `done` (commit), then `system.post(reply_to, 'github.closed', {effectKey, commentId})`.
- **Failure** (HTTP non-2xx, network, timeout 15 s, invalid response): if
  `attempts >= 6` → `dead`, `last_error`, `github.gave-up {effectKey,
  attempts, lastError}` to `reply_to`; else `pending` with `next_attempt_at =
  now + Retry-After` (seconds or HTTP date) when the response had one, else
  `RELAY_BASE_DELAY_MS * 2^(attempts-1)` + up to 250 ms jitter, capped at 5 min.
  With the default 1000 ms a `dead` row takes ≈ 31 s; tests may set
  `RELAY_BASE_DELAY_MS=100` (≈ 3 s).
- **Processor shortcut:** a `github.close` for a row already `done` replies
  `github.closed` at once; for a `dead` row, `github.gave-up` at once.
- **Operator retry** (`Backend.retryEffect`): `dead`/`pending` → `pending`,
  `attempts 0`, due now, and in the same transaction the issue's `failed`
  verdict is deleted, so the relay's reply loads the actor in `closing`
  (loader: outbox row, no verdict) and it finishes `closed` with a fresh
  verdict. `done`/`inflight` → `conflict`.

### Observable effects (fake GitHub / tests)
- Not allowed: exactly one comment with the marker and one successful PATCH
  per issue, however often the webhook is delivered or the app restarted.
- Allowed / duplicate / settled: no REST call at all.
- A failed call is retried; the retry after a failed attempt first does one
  `GET …/comments` when no `comment_id` was stored.
- A second `github.closed` after a retry-effect (processor + relay) is a
  harmless dead letter (`done`) or loads a `settled` actor.

## Consequences
At-most-once comment per effect key relies on the marker search; a comment
posted by a crashed attempt whose response was lost is adopted, not
duplicated. Replies are not trace-linked to the issue's trace yet (the relay
posts without a `traceparent`).
