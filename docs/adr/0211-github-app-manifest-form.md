# 211. Creating the GitHub App from the browser; callback redirects

Date: 2026-09-28 · Status: accepted · Fork E5 (ADR 0160, 0166)

## Decision
- GitHub's manifest flow requires the *browser* to POST a form to
  `{GITHUB_WEB_URL}/settings/apps/new?state=…` (or
  `/organizations/<org>/settings/apps/new?state=…`) with a single field named
  `manifest` containing the JSON manifest. The wizard asks the server for
  `ManifestFormData` (`beginGitHubAppManifest` command — stores the nonce),
  renders a hidden `<form method="post" action={postUrl}>` with that one
  field, and calls `form.submit()`. No `+page.server.ts` is needed.
- Wizard inputs: owner (personal account or an organization login, validated
  as a GitHub login) and an optional app name (≤ 34 chars; default
  `granary-<host>` from the server). The page states the permissions and
  events the manifest asks for, and warns (without blocking) when ORIGIN is
  not https; it is disabled when ORIGIN is unknown.
- **Redirect contract with fork E3:** `/settings/github/callback` and
  `/settings/github/installed` (E3's `+server.ts`) redirect to
  `/settings/github` with one of `?created=1` (app stored — prompt to
  install), `?installed=1` (post-install), or `?error=<human message>`
  (shown in a destructive alert with "start again"). The page shows these as
  alerts; no other state is passed in the URL.

## Consequences
The fake GitHub (E4) must accept a form POST with a `manifest` field at those
paths, honouring `state` in the query string.
