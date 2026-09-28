# 281. Pull request access for existing GitHub Apps

Date: 2026-09-28 · Status: accepted

## Context
Production's app was created with issues permissions only. GitHub never
lets an app raise its own permissions: the owner edits the app's
permissions, and every installation's account must accept them.

## Decision
- granary stores what the app asks for (`github_app.permissions/events`,
  from the manifest conversion and every `GET /app` check) and what each
  installation accepted (`github_installations.permissions/events`, from
  `GET /app/installations` and `installation` webhooks, including
  `new_permissions_accepted`, which also drops cached installation tokens).
- An installation has **pull request access** when it accepted
  `pull_requests: write` and the `pull_request` event. Repos expose
  `prAccess`; the settings UI keeps their pull request switch disabled
  ("no access") until then.
- `GitHubStatus.pullRequests` reports app permission, app event, pending
  installations, the app's permissions URL and `ready`. Settings → GitHub
  shows a **Grant pull request access** card with the steps; **Refresh**
  re-reads `GET /app` (bypassing the 60 s auth-check cache) and the
  installations.
- Steps for the owner: app settings → Permissions & events → Pull requests:
  Read and write; Subscribe to events → Pull request; Save; then on each
  installation "Review request" → Accept new permissions; then Refresh.

## Consequences
No token or secret changes; access appears as soon as GitHub delivers
`new_permissions_accepted` (or on Refresh). Documented in the manual (first
run §4, policy, runbook).
