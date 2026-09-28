# 160. The GitHub connection is a GitHub App created in-product

Date: 2026-09-28 · Status: accepted · Supersedes the env-only parts of 0005/0034

## Decision
**Mode:** `github.mode = 'app' | 'token' | 'none'` (setting in
`granary.sqlite`). `app` is the product path. `token` (PAT + webhook secret +
separate OAuth app) exists only for seeds/tests/legacy and is configured via
env seeds or `granary config set`, not the wizard. `none` = setup required.

**Creating the app — manifest flow** (`/settings/github`, admins only):
1. The page renders a form that POSTs `manifest` (JSON) to
   `https://github.com/settings/apps/new?state=<nonce>` (or
   `/organizations/<org>/settings/apps/new` when an org is entered).
   `GITHUB_WEB_URL` keeps pointing this at the fake in dev/tests.
2. Manifest: `name` (default `granary-<host>`), `url` = ORIGIN,
   `hook_attributes.url` = `ORIGIN/webhook`, `redirect_url` =
   `ORIGIN/settings/github/callback`, `callback_urls` =
   [`ORIGIN/auth/callback`], `request_oauth_on_install: false`,
   `setup_url` = `ORIGIN/settings/github/installed`, `public: false`,
   `default_permissions` = `{ issues: 'write', metadata: 'read' }`,
   `default_events` = `['issues']`.
3. GitHub redirects to the callback with `code` + `state`; the server checks
   the nonce (cookie + DB, 10 min TTL) and calls
   `POST {GITHUB_API_URL}/app-manifests/{code}/conversions` → app `id`,
   `slug`, `client_id`, `client_secret`, `webhook_secret`, `pem`,
   `html_url`, `owner`. Secrets go to the platform store (ADR 0158); the rest
   to the `github_app` row. Mode becomes `app`.
4. The page then links to `https://github.com/apps/<slug>/installations/new`.

**Installations & repo policy:** `github_installations` (id, account login,
type, repository_selection, suspended) and `github_repos` (repo id,
full name, installation id, `enabled` default true). Synced on the
`installation` / `installation_repositories` webhook events (added to the
accepted event list) and by "Refresh" (`GET /app/installations`,
`GET /installation/repositories`). A webhook for a repo that is unknown or
disabled is stored as `ignored` (reason recorded). Policy remains global
(allowlist + associations, ADR 0004); per-repo policies are out of scope.

**Auth for REST calls (relay, catch-up):** app JWT (RS256 via WebCrypto,
`iat = now-60s`, `exp = now+9m`, `iss = app id`) → `POST
/app/installations/{id}/access_tokens` → token cached per installation until
5 min before `expires_at`. The outbox payload gains `installationId`
(optional, additive); the relay picks the token by installation. Token mode
keeps using the single PAT.

**Webhook verification:** secret from the store (app or token mode). During
`none`, webhooks are rejected with 503 (GitHub retries nothing; catch-up
handles the gap once connected).

**UI sign-in:** the GitHub App's own OAuth (user-to-server web flow:
`/login/oauth/authorize?client_id=<app client id>` → `access_token` → `GET
/user`). The separate OAuth app is only used in token mode. Only admins may
sign in (ADR 0034 rule kept, admins now from ADR 0161).

## Consequences
One click-through on GitHub creates webhook URL, secret, permissions and
OAuth in one go; nothing is copy-pasted. Fake GitHub must implement the flow
(ADR 0164).
