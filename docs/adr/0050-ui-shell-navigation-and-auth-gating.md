# 50. UI shell, navigation and auth gating

Date: 2026-09-28 · Status: accepted · Partially superseded by 291

## Context
The admin UI (ADR 0008, 0021) needs one consistent frame for Overview,
Deliveries, Effects, Verdicts, Allowlist, Actors and, in dev mode, `/__dev`
(ADR 0009). Reads need a user, mutations an admin (ADR 0031); anonymous
visitors must see a sign-in page, not a wall of 401s.

## Decision
- `src/routes/+layout.server.ts` returns `{user: locals.user, devMode: locals.devMode}`
  straight from `locals` (filled by `hooks.server.ts`). The shell needs no
  remote round-trip to decide what to render. Components read it through
  `shellData()` / `isAdmin()` (`src/lib/components/app/session.ts`).
- `+layout.svelte` renders `ModeWatcher` (light/dark follows
  `prefers-color-scheme`, toggle in the top bar), `Toaster`, one
  `Tooltip.Provider`, and then either:
  - `AppShell` (sidebar ≥ lg, top bar with a scrolling nav below lg, user menu),
    when there is a user, or the route is `/__dev` in dev mode, or an error page; or
  - `SignInLanding` otherwise: "Sign in with GitHub" →
    `/auth/login?redirect=<path+search>` (full reload, it is a server route),
    plus a "Developer console" link in dev mode.
  Page components are not rendered for anonymous users, so their queries never run.
- Navigation is `src/lib/components/app/nav.ts`; the `Dev` item is shown only
  when `devMode` is true.
- User menu: avatar + login + role; "Log out" calls the `logout` command and
  then `goto('/', {invalidateAll: true})` (commands cannot redirect).
- Admin-only controls are wrapped in `AdminOnly`: admins get them enabled;
  everyone else gets them disabled inside a tooltip saying why. The server
  still enforces `requireAdmin()`; the UI only avoids offering dead buttons.

## Consequences
The layout load is the only non-remote server code in the UI, and it touches
nothing but `locals`. A user who loses admin rights sees read-only controls
on the next navigation (ADR 0034).
