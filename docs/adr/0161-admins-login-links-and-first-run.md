# 161. In-product admins, login links, and the first-run wizard

Date: 2026-09-28 · Status: accepted · Amends 0004 (admins), 0034

## Decision
- **Admins** live in `admins` (login COLLATE NOCASE PK, added_by, added_at,
  source `seed|cli|ui`). `GRANARY_ADMINS` (alias `ADMINS`) seeds rows at boot
  if absent. `SessionUser.isAdmin` is computed from the table. The last admin
  cannot be removed (409).
- **Login links** (`granary login-link <login> [--ttl]`, default 15 min, max
  24 h): 32 random bytes, base64url, shown once as
  `ORIGIN/auth/link/<token>`; stored as SHA-256 in `login_links` (hash PK,
  login, created_at, expires_at, used_at, created_by). `GET /auth/link/<token>`
  renders a confirm page (so link-preview bots don't consume it); `POST`
  consumes it atomically (single use), creates a normal session for `login`
  and redirects to `/settings/github` if setup is incomplete, else `/`. The
  login must be an admin at consume time.
- **First run:** `setup_state` = `needs-github` until mode ≠ `none`,
  then `ready`. While `needs-github`, admins see a setup banner and `/` redirects
  them to `/settings/github`; everyone else sees "granary is being set up".
- **Audit:** admin add/remove, link creation/consumption and GitHub
  connection changes are written to `audit_log` in granary.sqlite.

## Consequences
Bootstrap over SSH is two commands: `granary admin add <you>` and
`granary login-link <you>`. No proxy- or host-specific auth is needed.
