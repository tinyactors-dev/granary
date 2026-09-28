# 170. Login links: confirm page, revocation, ids without tokens

Date: 2026-09-28 · Status: accepted · Implements 0161

## Decision
- `GET /auth/link/<token>` renders a standalone confirm page (the root layout
  lets `/auth/link/*` render for anonymous visitors instead of the sign-in
  landing); it never touches the token. `POST` (form action) consumes it
  atomically: `UPDATE … SET used_at WHERE token_hash = ? AND used_at IS NULL
  AND revoked_at IS NULL AND expires_at > now RETURNING login`, then checks the
  login is still an admin, creates a normal session and redirects to
  `/settings/github` while setup is `needs-github`, else `/`. Headers:
  `cache-control: no-store`, `referrer-policy: no-referrer`.
- Tokens: 32 random bytes, base64url; only SHA-256 (hex) is stored. Links are
  listed and revoked by **id = first 16 hex characters of that hash** — enough
  to address a link, useless to sign in with. Migration 3 adds
  `login_links.revoked_at`.
- Additive contract: `Backend.listLoginLinks(limit)` (newest first, state
  `valid|used|expired|revoked`) and `Backend.revokeLoginLink(id, actor)`
  (`not-found` for an unknown id, `revoked:false` when already used, expired
  or revoked); audit action `login-link.revoke`. Not yet surfaced in the UI
  (E6/settings follow-up).
