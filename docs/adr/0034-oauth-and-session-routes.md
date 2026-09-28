# 34. OAuth and session route contract

Date: 2026-09-28 · Status: accepted

## Context
UI login is GitHub OAuth (real GitHub or the fake, ADR 0006). Remote
functions cannot redirect from commands or set cookies from queries, so the
OAuth dance is plain SvelteKit routes, implemented by the actor-system agent.

## Decision
- `GET /auth/login?redirect=<path>`: generate a random `state`, store
  `state` + the sanitized redirect (`safeRedirectPath`) in cookie
  `granary_oauth_state` (httpOnly, sameSite=lax, path=/auth, 10 min), then
  302 to `${GITHUB_WEB_URL}/login/oauth/authorize?client_id&redirect_uri=${ORIGIN}/auth/callback&state`
  (`OAuthAuthorizeQuery`).
- `GET /auth/callback?code&state` (`OAuthCallbackQuery`): verify `state`
  against the cookie (400 otherwise), `POST ${GITHUB_WEB_URL}/login/oauth/access_token`
  (JSON, `Accept: application/json`, `OAuthAccessTokenRequest`), parse
  `OAuthAccessTokenResponse` (an `error` object → 401 page), `GET
  ${GITHUB_API_URL}/user` with `Authorization: Bearer <token>`
  (`AuthenticatedUser`). Only logins in `ADMINS` may sign in (ADR 0005:
  "logins allowed into the UI"); others get a 403 page. Then
  `getBackend().createSession({login, avatarUrl})`, `setSessionCookie(...)`,
  delete the state cookie, 303 to the stored redirect. The GitHub access
  token is not stored.
- Cookie `granary_session` (`SESSION_COOKIE`): value = `sessions.id`
  (random ≥ 32 bytes, base64url/hex), `httpOnly`, `sameSite=lax`, `path=/`,
  `secure` when the request is https, `expires` = `expires_at` = now + 30 days
  (`SESSION_TTL_MS`). Helpers: `setSessionCookie`, `clearSessionCookie` in
  `src/lib/server/auth.ts`.
- `sessions` table (ADR 0003): `id, login, avatar_url, created_at, expires_at`
  (`SessionRow`). Expired rows are treated as absent and may be swept.
- `hooks.server.ts` `handle`: read the cookie, `getBackend().resolveSession(id)`,
  set `locals.user` (with `isAdmin` computed from `ADMINS` at request time),
  `locals.sessionId` (null if unresolved) and `locals.devMode` (`isDevMode`).
- Logout is the `logout` remote command (ADR 0031); dev login is the
  `devLoginAs` form, which may create a session for **any** login (also
  non-admins, to see the read-only UI).

## Consequences
Removing a login from `ADMINS` revokes admin rights on the next request; its
existing session still reads dashboards until it expires or logs out.
