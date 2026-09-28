# 33. Event and message protocol between actors, processors and the WAL

Date: 2026-09-28 · Status: accepted

## Context
ADR 0002 names the actors and events; their data shapes and keys must be
exact so the webhook route, loader, actors, `github` I/O processor, relay
and system hooks agree. All shapes are in `src/lib/schemas/actors.ts`
(events) and `src/lib/schemas/wal.ts` (rows / JSON columns).

## Decision
Keys and addresses:
- issue key `"<repository.id>-<issue.number>"` (`issueKey()`); issue actor
  address `{family:'issue', name: issueKey}` (`issueAddress()`);
  `ALLOWLIST_ADDRESS = {family:'allowlist', name:'main'}`.
- outbox effect key `close:<repoId>:<number>` (`closeEffectKey()`).
- `outbox.reply_to` = JSON `ActorAddress`; `outbox.payload` = JSON
  `OutboxPayload` (= `github.close` data); `inbox.payload` = raw webhook text.

Events (`EVENTS.*`), data schema, sender → receiver:

| Event | Data | From → to |
|---|---|---|
| `issue.opened` | `IssueOpenedData {deliveryId, issueKey, repoId, owner, repo, number, author, authorType, association, title, htmlUrl}` | webhook route / boot re-post / sweeper → `issue/<key>` |
| `allowlist.check` | `{login, association}` | issue → `allowlist/main` (reply to `event.origin`) |
| `allowlist.verdict` | `{login, allowed, reason: 'allowlist'\|'association'\|'not-allowed'}` | allowlist → issue |
| `allowlist.replace` | `{logins: string[]}` (full set) | Backend after writing `allowed_users` → allowlist |
| `github.close` | `GitHubCloseData {repoId, owner, repo, number, author, association, title, htmlUrl, deliveryId}` | issue → `github` I/O processor (`GITHUB_IO_TYPE`) |
| `github.closed` | `{effectKey, commentId: number\|null}` | processor (row already done) or relay → `reply_to` |
| `github.gave-up` | `{effectKey, attempts, lastError}` | relay → `reply_to`, after `MAX_EFFECT_ATTEMPTS` (6) |
| `check.timeout` | none (`undefined`) | issue → itself, delay `CHECK_TIMEOUT_MS` (10 s), send id `check-timeout` |

Issue actor:
- Loader binding `IssueLoaderBinding {issueKey, phase: 'new'|'closing'|'settled', issue?}`;
  `issue` is present for `closing` (rebuilt from the outbox payload).
- Data model `IssueActorData {issueKey, phase, issue, deliveryId, verdict, reason}` (nullable fields start null).
- Done-data `IssueDoneData {issueKey, deliveryId: string|null, verdict: 'allowed'|'closed'|'failed'|'settled', reason}`.
  Reasons: allowed → `allowlist`|`association`; closed → `not-allowed`;
  failed → `github-gave-up: <lastError>` | `check-timeout`; settled → `already-settled`.
- The `done` hook writes `verdicts` for allowed/closed/failed (`VerdictValue`),
  never for `settled`, and marks inbox row `deliveryId` `done` in the same
  transaction. The `fault` hook marks it `failed`.
- Allowlist actor data `AllowlistActorData {logins: string[]}` (lower-cased).

Every receiver validates event data with `parseEventData(event, data)` at its
boundary (I/O processor, relay reply, done hook); charts may trust data they
received from a validated sender.

## Consequences
Adding an event means adding it to `EVENTS`, `EVENT_DATA` and `EventDataMap`.
