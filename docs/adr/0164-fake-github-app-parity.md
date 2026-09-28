# 164. Fake GitHub parity for GitHub Apps

Date: 2026-09-28 · Status: accepted · Extends 0006, 0035, 0060

## Decision
The fake GitHub gains (GitHub-compatible paths and shapes):
- **Manifest flow:** `POST /settings/apps/new?state=` (and the
  `/organizations/{org}/…` variant) accepts the `manifest` form field and
  renders a confirm page; `?auto=1` skips it. Confirm redirects to the
  manifest's `redirect_url?code=…&state=…`.
  `POST /app-manifests/{code}/conversions` (single use, 1 h) returns
  `id, slug, node_id, owner, name, html_url, client_id, client_secret,
  webhook_secret, pem, permissions, events`. The fake generates a real RSA
  key pair so JWT verification is genuine.
- **App auth:** `GET /app` with `Authorization: Bearer <JWT>` (RS256 verified
  against the app's public key, `iss` = app id, `exp` ≤ 10 min, clock skew
  60 s). `GET /app/installations`, `POST /app/installations/{id}/access_tokens`
  (1 h tokens, `expires_at`), `GET /installation/repositories` (installation
  token). REST endpoints accept installation tokens and reject tokens of other
  installations for repos outside them (404).
- **Installations:** `GET /apps/{slug}/installations/new` renders "install on
  account X, repos …"; confirming creates the installation, sends the
  `installation` webhook, and redirects to the app's `setup_url?installation_id=…&setup_action=install`.
- **Deliveries:** every webhook delivery is recorded per app;
  `GET /app/hook/deliveries` (id, guid, delivered_at, redelivery, status,
  status_code, event, action) and `POST /app/hook/deliveries/{id}/attempts`
  (resends with the same guid, marks `redelivery: true`).
- **App OAuth:** `/login/oauth/authorize` and `/login/oauth/access_token`
  accept the app's client id/secret too.
- **Control API additions** (`fake-github/schemas.ts`, additive):
  `POST /__control/apps/{appId}/installations` (install without UI),
  `POST /__control/webhook-outage` `{ down: boolean }` (deliveries fail with
  `status_code: 0` while down, to test catch-up), and `state` includes
  `apps`, `installations`, `appDeliveries`.
- Token mode (PAT) keeps working unchanged for existing tests.

## Consequences
The whole setup wizard, installation tokens and catch-up are testable
end-to-end without network access.
