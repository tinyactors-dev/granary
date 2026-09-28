# 192. Webhooks: secret by mode, per-repo policy, installation sync

Date: 2026-09-28 · Status: accepted · Refines 0003, 0160

## Decision
`handleWebhook` (`src/lib/server/inbound.ts`; the route only adapts it):
- **Secret**: from the connection — app mode: `github-app-webhook-secret`;
  token mode: `github-webhook-secret` (store) or the legacy env value; `none`
  or no secret → **503** (GitHub records a failure; catch-up redelivers it
  once connected).
- **Lifecycle events** (`installation`, `installation_repositories`) update
  installations/repos in app mode (created/deleted/suspend/unsuspend,
  repositories added/removed); not re-applied for a duplicate delivery id.
  They are stored as `ignored` inbox rows.
- **Per-repo policy** for `issues`: a disabled repo → `ignored` (all modes).
  App mode, unknown repo: if the signed delivery carries `installation.id`
  the repo is registered (enabled) and guarded — deliveries can arrive before
  the installation sync; without an installation → `ignored`. Token mode has
  no repo inventory: unknown repos are guarded (today's behaviour).
- The ignore **reason** is logged and returned in the 202 body; the inbox has
  no reason column (adding one is a WAL migration owned elsewhere) — E6 may
  add it.
