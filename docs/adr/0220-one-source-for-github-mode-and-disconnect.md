# 220. One source for `github.mode`; admins table at sign-in; disconnect

Date: 2026-09-28 · Status: accepted

## Context
After the parallel build (ADR 0166) three places disagreed about the GitHub
connection mode: the connection read the platform `settings` kv (raw text),
`granary config set` wrote `github_settings`, and setup state read
`github_settings` and additionally inferred token mode from
`GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET`. `/auth/callback` still checked the
env `ADMINS` list, and disconnecting required the CLI.

## Decision
- `github.mode` and `github.token.oauthClientId` live **only** in the
  platform `settings` kv, JSON-encoded like every other setting
  (`AdminStore`). `github_settings` holds only the connection's internal
  state (catch-up checkpoint/status, schema steps), readable but not
  settable through `granary config`.
- The connection's boot seeds always write `github.mode`; setup state is
  `ready` iff the mode is `app` or `token` (no env inference).
- Writes that bypass the connection (`config set|seed` over the admin
  socket) call `GitHubConnection.refreshMode()`, which notifies mode
  listeners (e.g. the catch-up actor starts/stops) and clears cached
  installation tokens.
- `/auth/callback` admits only logins in the admins table (case-insensitive).
- `Backend.disconnectGitHub(actor)` (button + confirm dialog on
  `/settings/github`): mode → `none`; the app row, installations, pending
  manifests and every stored GitHub credential are deleted; per-repo
  enable choices are kept for a later reconnect. The app itself must be
  deleted on GitHub (the page links to it). Audited as `github.disconnect`;
  app creation and repo enable/disable are now audited too.

## Consequences
One place to look for the mode; reconnecting after a disconnect runs the
normal manifest flow again (no "app already configured" conflict).
