# 53. Developer console (`/__dev`) design

Date: 2026-09-28 · Status: accepted · Partially superseded by 290

## Context
ADR 0009 lists what `/__dev` offers. It must work before anyone is logged in
(it is how you log in) and it only exists in dev mode (hooks return 404).

## Decision
One page, four cards, with anchor links (`#login`, `#fake-github`,
`#debugger`, `#spans`), all fed by `getDevInfo()`:
1. **Log in as** — one `devLoginAs` form: quick buttons (ADMINS, `admin`,
   `alice`, `mallory`) and a free-text login; `redirectTo` comes from
   `?redirect=` (defaults to `/`). The server answers 303 and the layout data
   is invalidated.
2. **Fake GitHub** — summary counts from `fakeGithub.state` (or an alert
   when unreachable); forms: open issue (`devOpenIssue`, owner/repo/author/
   title/body/association), inject fault (`devInjectFault`, numbers via
   `.as('number')`), redeliver by id; per-row Reopen (as the repo owner) and
   Redeliver buttons in tabbed issue/delivery/fault tables; Reset behind a
   confirmation dialog.
3. **Debugger** — DAP host/port and attach instructions (tinyactors-vscode);
   resident actors (from `listActors`, which needs a user) expand to a
   copyable `launch.json` built from `getDapLaunchConfig`; a "send event"
   form (family, name, event with suggestions from `EVENTS`, JSON data
   validated client-side before `devSendEvent`) shows the result.
4. **Live spans** — `getRecentSpans({limit: 100, family?})`, family filter,
   live polling every 2 s (on by default), rows expand to attributes/events.

## Consequences
`listActors` requires a user (ADR 0031), so anonymous visitors see a
"log in above" hint instead of the actor list; sending events by address
still works.
