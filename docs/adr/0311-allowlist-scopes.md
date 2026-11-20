# 311. Allowlist entries have a scope: everywhere, an owner, or a repository

Date: 2026-11-20 · Status: accepted (amends ADR 0004 and 0260)

## Context
An approved introduction lets someone into one repository, or into every
repository of an owner (ADR 0310). The allowlist was one global set of
logins.

## Decision
- `allowed_users` holds `(login, scope)` pairs (migration 5; existing rows
  get scope `''`). Scope `''` = every repository, `<owner>` = every
  repository of that owner, `<owner>/<repo>` = one repository; stored
  lower-cased.
- The policy (`decidePolicy`) gets the item's `owner` and `repo`; an
  allowlist entry matches when its scope is `''`, the owner, or
  `owner/repo`. Precedence is unchanged (blocklist → allowlist →
  association → not allowed). `allowlist.check` carries `owner` and `repo`;
  `allowlist.replace` carries `entries: {login, scope}[]`.
- UI (Policy → Allowlist), remote functions, admin socket and CLI
  (`granary allowlist add <login> [--scope <owner>|<owner>/<repo>]`, `remove`
  likewise) take an optional scope; the list shows it ("everywhere",
  "acme", "acme/widgets").

## Consequences
Chart revisions: allowlist v3, issue v3. Approving an introduction never
widens access beyond its scope.
