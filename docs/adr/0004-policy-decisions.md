# 4. Policy: who may open issues

Date: 2026-09-28 · Status: accepted

## Decision
- An issue is **allowed** if the author's login is in `allowed_users`
  (case-insensitive) **or** its `author_association` is `OWNER`, `MEMBER` or
  `COLLABORATOR` (maintainers can never lock themselves out).
- Only `issues` / `action: opened` is acted on. Reopened, edited, transferred
  issues are ignored; a maintainer reopening an issue is final.
- Bots (`user.type == "Bot"`) are treated like any other user.
- Closing comment (configurable later): "Thanks for the report! Issues in this
  repository can only be opened by approved contributors, so this one was
  closed automatically."
- The allowlist is managed in the UI by **admins** (logins in env `ADMINS`,
  comma-separated). Changes write `allowed_users` then post
  `allowlist.replace` to `allowlist/main`.
