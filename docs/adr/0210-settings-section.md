# 210. The /settings section

Date: 2026-09-28 · Status: accepted · Fork E5 (ADR 0166)

## Decision
- `/settings` is a main-nav entry ("Settings") with its own sub-navigation
  (`src/lib/components/settings/SettingsNav.svelte`), like `/ops`:
  **General** (ORIGIN, webhook URL, master-key state, setup checklist, where
  settings come from — ADR 0157), **GitHub** (wizard or connection),
  **Admins**, **Login links** and **Audit log**. The last two are hidden
  from non-admins; every other page is read-only for them (controls disabled
  via `AdminOnly`, the server re-checks with `requireAdmin`).
- Remote functions live in `src/lib/remote/settings.remote.ts`, validated
  with TypeBox through `standard()` and delegating to the Backend methods
  pinned in ADR 0166: `getSetupStatus` (null when anonymous/no backend, so
  the banner is safe everywhere), `listAdmins`, `addAdmin` (form),
  `removeAdmin`, `createLoginLink` (form), `listAuditLog` (admin only),
  `getGitHubStatus`, `beginGitHubAppManifest`, `refreshGitHubInstallations`,
  `setRepoEnabled`. Reads need a signed-in user, mutations an admin;
  mutations refresh the affected queries in the same response.
- **First-run banner** (`SetupBanner.svelte`, rendered by the root layout for
  signed-in users outside `/__dev`, hidden on `/settings/github`): admins get
  "One step left: connect granary to GitHub" with a button, everyone else
  "granary is being set up". The redirect of `/` to the wizard for admins is
  E1's (hooks, ADR 0161).
- **Login links** are shown exactly once: the URL only exists in the
  `createLoginLink` form result held by the page component; nothing caches it.
- Tone is calm and explanatory, matching `/ops` (ADR 0104).

## Consequences
Every Backend method E1/E3 implement already has a UI; the stub
(`GRANARY_STUB_GITHUB_MODE=none|app|token`, read by hooks when
`GRANARY_STUB_BACKEND=1`) exercises both the wizard and a connected app.
