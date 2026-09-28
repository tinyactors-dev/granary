# 63. Integration test scenarios

Date: 2026-09-28 · Status: accepted

## Decision
Each scenario asserts through the app's traces and the fake GitHub's
state. "Closed once" = issue `closed`/`not_planned` with exactly one
comment containing `<!-- granary:close:<repoId>:<n> -->`.

`tests/policy.test.ts`
- alice (seeded allowlist) → `allowed`, issue open, no comment; `ALICE` too.
- unknown user → `closed` once; the session went `checking → closing →
  closed` taking `issue.opened, allowlist.verdict, github.closed`.
- unknown Bot user → closed (bots are not special).
- association `OWNER` / `MEMBER` / `COLLABORATOR` → `allowed`;
  `CONTRIBUTOR` → closed.
- duplicate delivery: redeliver the same id while closing and after →
  2xx both times, closed once, a single `closed` finish.
- reopened by a maintainer → `issues.reopened` delivered, ignored: issue
  stays open, one `issue.opened` macrostep, one `closed` finish.
- invalid / missing / wrong-secret signature → 401, no span mentions the
  issue key or repo id.

`tests/faults.test.ts`
- 500 on `POST …/comments` ×2 → closed once, fault budget used up.
- 403 with `Retry-After: 3` → closed once, comment created ≥ 2.5 s after
  the issue.
- permanent 500 → issue actor ends `failed` via `github.gave-up`
  (done reason `github-gave-up: …`), issue open, no comment.

`tests/crash.test.ts`
- SIGKILL right after the 202 → restart on the same DB → closed once,
  one `closed` finish.
- PATCH fails once with `Retry-After: 5`; SIGKILL once the comment exists
  → after restart the issue is closed by the new process (epoch 1) with
  still exactly one comment.

`tests/oauth.test.ts`
- `/auth/login` → fake authorize `?login=admin` → `/auth/callback` →
  `granary_session` cookie → `GET /` (SSR) contains `admin`.
- non-admin login → 403, no session; wrong `state` → 400.

## Consequences
The permanent-failure test takes as long as the relay's backoff (≤ 180 s
budget). New behaviour gets a scenario here and a test file entry.
