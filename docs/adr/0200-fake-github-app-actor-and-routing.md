# 200. Fake GitHub Apps: one `apps/main` actor, repo events routed to installed apps

Date: 2026-09-28 · Status: accepted · Implements 0164

## Decision
- One new actor `apps/main` (`fake-github/actors/apps.ts`) holds registered
  apps, single-use manifest codes, installations, installation tokens and each
  app's delivery log. HTTP handling, crypto and webhook fan-out live in
  `fake-github/app-routes.ts` (a module the server composes, not an actor).
- **Routing of repository events** (`issues`, `issue_comment`): if one or more
  non-suspended installations cover the repo (`all` = every repo of the
  account, `selected` = listed `owner/name`) and the app subscribes to the
  event, the event goes to each such app's `hook_attributes.url`, signed with
  that app's webhook secret, with `installation: {id, node_id}` added to the
  payload and GitHub's `X-GitHub-Hook-Installation-Target-*` headers.
  Otherwise it goes to the default repo webhook (`FAKE_GITHUB_WEBHOOK_URL` /
  `GITHUB_WEBHOOK_SECRET`) exactly as before, so token-mode tests are
  unchanged. Raw deliveries (`/__control/deliveries/raw`) always use the
  default webhook.
- Installing again for the same app+account updates the selection and sends
  `installation_repositories` (`added`/`removed`) instead of `installation`.
- The delivery actor gained `url`, `secret`, `appId`, `installationId`; the
  `webhook` I/O processor honours them and the outage switch.
