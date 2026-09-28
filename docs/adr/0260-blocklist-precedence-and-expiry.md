# 260. A blocklist that beats the allowlist and maintainer associations

Date: 2026-09-28 · Status: accepted

## Context
ADR 0004 allows allowlisted logins and OWNER/MEMBER/COLLABORATOR authors.
The operator is the repository owner, so they could never see granary
close one of their own issues, and had no way to test the flow end to end
in production. There was also no way to close issues from a specific
maintainer-association account (e.g. a misbehaving bot collaborator).

## Decision
- **Precedence**, first match wins: `blocklist` → closed; `allowlist` →
  allowed; `association` (OWNER/MEMBER/COLLABORATOR) → allowed; else
  `not-allowed` → closed. The rule lives in one kind-agnostic function,
  `decidePolicy(lists, {login, association}, now)` in
  `src/lib/server/policy.ts`, so pull requests can use the same policy.
- **Storage**: table `blocked_users(login PK NOCASE, note, expires_at,
  added_by, added_at)` (granary.sqlite migration 2). Blocking is an upsert:
  re-blocking replaces note and expiry.
- **Expiry** (`expires_at`, nullable = until removed) is evaluated at
  decision time; no timers, no cleanup job. Expired rows stay visible
  (`active: false`) as history. The UI offers 1 h / 1 d / 7 d / until
  removed and a one-click "Block me for 1 hour" for the signed-in admin;
  the CLI takes `--for <duration>`.
- **Actor**: `allowlist/main` holds `{logins, blocked}` and answers
  `allowlist.verdict` with reason `blocklist` when a block applies; a new
  `blocklist.replace {entries}` event swaps the list after each change
  (same pattern as `allowlist.replace`). The issue actor now keeps the
  verdict's reason through `github.closed`, so `verdicts.reason` is
  `blocklist` or `not-allowed`. Chart revisions: allowlist v2, issue v2.
- **Interfaces**: Backend `listBlockedUsers` / `blockUser` / `unblockUser`,
  remote functions in `allowlist.remote.ts` (mutations admin-only),
  admin-socket commands `blocklist/add|remove|list`, CLI `granary blocklist
  add|remove|list` (socket, or direct writes when no server runs — safe,
  `allowlist/main` reads the table at boot). Every change is audited
  (`blocklist.add` / `blocklist.remove`).
- The UI warns when the login being blocked is yourself, and marks blocked
  admins ("their own issues are closed").

## Consequences
An owner can test the whole close flow on production in a minute and undo
it (or let it expire). Blocking a maintainer is deliberate and visible;
the allowlist and association rules are unchanged otherwise.
