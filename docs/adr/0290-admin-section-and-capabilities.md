# 290. An admin section in every environment, gated by capability

Date: 2026-09-28 · Status: accepted · Supersedes the routing parts of 0009, 0053, 0076 and the dev-only rule of 0154

## Context
The developer console lived at `/__dev` and existed only in development mode
(ADR 0009). Operating granary in production needs most of it too — the actor
list and inspector, traces, the debugger — and the simulation services (fake
GitHub, fake-infra, load tester) are useful for exercising a deployment. The
design audit also found actor internals spread over the user-facing pages
(main-nav "Actors", Ops → Actors, Overview runtime cards, the issue page's
"Live actor" card).

## Decision
- **`/admin` replaces `/__dev`.** Its own sidebar (Inspect: Overview, Actors,
  Traces, Debugger · Simulate: Fake GitHub, Fake infra, Load tester, Personas ·
  Develop: Sessions, Components) and a "Back to app" link. `/__dev/*`
  redirects to `/admin/*` (308).
- **Who:** admins in every environment. In development mode also anonymous
  visitors, because `/admin/sessions` is where you sign in. In production a
  signed-out visitor gets the sign-in page and a signed-in non-admin gets 404
  (hooks); every remote function behind the section calls
  `requireAdminArea(capability?)`.
- **Capabilities** (`src/lib/schemas/admin.ts`, computed once in hooks from
  configuration, passed to the shell as `admin`):

  | Capability | On when | Gates |
  |---|---|---|
  | `impersonate` | development mode | "log in as" (`devLoginAs`) |
  | `debugger` | development mode or `GRANARY_DEBUGGER=1` | the DAP server, send event, launch configs |
  | `fakeGithub` | development mode or `FAKE_GITHUB_URL` set | fake-GitHub actions |
  | `fakeInfra` | development mode or `FAKE_INFRA_URL` set | fake-infra control |
  | `loadgen` | development mode or `LOADGEN_URL` set | scenarios, personas |
  | `devApi` | development mode | `/admin/api/ops` (tests, scripts) |

  Areas whose capability is off stay in the sidebar (marked "off") and show
  how to turn them on instead of their page. The overview lists all of them.
- **Impersonation stays development-only.** In production "log in as" would be
  a way for one admin to act as another person with no GitHub consent; the
  audited `granary login-link` on the host covers the bootstrap case.
- **Debugger:** always bound to `127.0.0.1`. Off in production unless
  `GRANARY_DEBUGGER=1`; the page explains the SSH tunnel
  (`ssh -L 4711:127.0.0.1:4711 <host>`).
- **Simulation in production is inert by default and safe by construction.**
  The fake GitHub signs its webhooks with its own app's secret, so a
  production granary (whose webhook secret belongs to the real GitHub App)
  rejects them with 401; the fakes never talk to github.com. Using the load
  tester against a deployment therefore needs a **separate sandbox instance**
  of granary (own data dir, port and `GRANARY_GITHUB_*` pointing at the fake),
  with the fakes bound to localhost next to it. This ADR ships the admin areas
  and the "not configured" states; running a sandbox is documented, not
  automated.
- **Traces in production:** the tracer keeps the last `SPAN_BUFFER_SIZE` spans
  in memory in every environment (it only did in development) so
  `/admin/traces` works everywhere.
- **Actor internals moved here:** `/actors` and `/actors/[family]/[name]` →
  `/admin/actors[/…]` (granary's and the ops module's actors on one page;
  `/ops/actors` redirects there); the debugger's attach/send-event tools →
  `/admin/debugger`; the Overview's runtime cards → the admin overview; the
  issue page links "Inspect actor" and "Traces" for admins only.
- Actor inspection (`listActors`, `inspectActor`) is admin-only.

## Consequences
The real backend no longer refuses its dev-console methods outside
development mode; authorization is the remote layer's job (ADR 0031) and the
capability decides. New env var `GRANARY_DEBUGGER` (ADR 0230 table updated).
