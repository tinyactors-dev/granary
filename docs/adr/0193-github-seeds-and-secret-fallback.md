# 193. GitHub seeds, secret fallback and sign-in credentials

Date: 2026-09-28 · Status: accepted · Refines 0157, 0160

## Decision
- **Seeds** (boot, `GitHubConnection.seed()`): a never-configured instance
  with `GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET` becomes **token** mode (the
  OAuth client id goes to `github_settings`); otherwise **none**. Seeds never
  change an existing mode. The manifest flow is the only way to **app** mode.
- **Secrets**: looked up in the platform store (E1, `granarySecretsOrNull()`)
  at the moment of use. In token mode, a secret missing from the store falls
  back to the legacy env value, so env-only deployments and the test harness
  keep working without a master key. When the store becomes usable, the env
  secrets are copied into it once (never overwriting).
- App mode requires the store: completing the manifest without a usable
  master key fails with `unavailable` before anything is written.
- **UI sign-in** uses `oauthCredentials()`: the App's client id/secret in app
  mode, the separate OAuth app in token mode; `/auth/login` and
  `/auth/callback` answer 503 before GitHub is connected (admins use
  `granary login-link`).
- The manifest callback requires the admin who started the flow
  (case-insensitive) and a fresh, unused nonce; `/settings/github/installed`
  re-syncs installations for a signed-in admin.
