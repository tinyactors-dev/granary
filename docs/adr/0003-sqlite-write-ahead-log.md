# 3. Application-level write-ahead log in SQLite

Date: 2026-09-28 · Status: accepted · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Context
tinyactors keeps captures in-process only. We need crash-safe handling of
inbound webhooks and outbound GitHub side effects.

## Decision
`bun:sqlite`, file at `DATABASE_PATH` (default `./data/granary.sqlite`),
`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`.

Tables (JSON columns are validated with TypeBox on read and write):

```sql
inbox(delivery_id TEXT PK, event TEXT, action TEXT, issue_key TEXT,
      payload TEXT, received_at INTEGER,
      state TEXT NOT NULL DEFAULT 'pending')  -- pending|done|failed|ignored
outbox(effect_key TEXT PK, issue_key TEXT, reply_to TEXT, payload TEXT,
       state TEXT NOT NULL DEFAULT 'pending', -- pending|inflight|done|dead
       comment_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
       next_attempt_at INTEGER, last_error TEXT, updated_at INTEGER)
verdicts(issue_key TEXT PK, verdict TEXT, reason TEXT, decided_at INTEGER)
allowed_users(login TEXT PK COLLATE NOCASE, added_by TEXT, added_at INTEGER)
sessions(id TEXT PK, login TEXT, avatar_url TEXT, created_at INTEGER, expires_at INTEGER)
```

Rules:
- **Inbound:** the webhook route verifies `X-Hub-Signature-256`, inserts
  (`INSERT OR IGNORE` on `X-GitHub-Delivery`) and commits **before** replying
  202. Non-`issues.opened` deliveries are stored as `ignored`.
- **Outbound:** no GitHub call happens before its outbox row is committed.
  The relay: (1) post comment carrying marker `<!-- granary:<effect_key> -->`,
  store `comment_id`; on retry skip if set, and search existing comments for
  the marker first; (2) `PATCH state=closed, state_reason=not_planned`
  (idempotent); (3) mark `done`, reply. Exponential backoff honouring
  `Retry-After`; after 6 attempts → `dead` + `github.gave-up`.
- **Boot order:** open DB → create system → spawn allowlist → register issue
  loader → start relay on pending/inflight rows → re-post every `pending`
  inbox row → accept HTTP. A sweeper re-posts `pending` inbox rows older than
  30 s (covers `queue-full`).
- **Loader:** verdict row → `phase: settled`; outbox row → `phase: closing`
  (+ issue payload); else fresh.

## Consequences
At-least-once delivery, at-most-once per effect key toward GitHub.
GitHub does not auto-redeliver failed webhooks; a catch-up job using the hook
deliveries API is future work.
