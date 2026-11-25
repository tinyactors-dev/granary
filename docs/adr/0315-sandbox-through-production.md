# 315. Use the sandbox through production: no SSH tunnel

Date: 2026-11-25 · Status: accepted (extends ADR 0312)

## Context
ADR 0312 runs a sandbox (a second granary on the fake GitHub) next to
production, listening on 127.0.0.1 only and reached through an SSH tunnel
of two ports. In production, Admin → Fake GitHub (and the other Simulate
areas) still says "Not available here" and does not even mention the
sandbox. The maintainer wants the full development simulation — fake
GitHub, fake infra, the load generator and its personas — on the
production machine, to demo and play with it from production's admin
section (including from a phone, where a tunnel is not practical) without
touching production's data. Only one port of the exe.dev VM is public
(granary's).

Whom it serves: production admins. Who pays: production forwards requests
to a process on its own machine for admins who ask for it; the sandbox uses
its own cookie names and serves its fake GitHub's pages under a path; the
package ships fake-infra and the load generator (about 0.6 MB); new
variables for production, the app and the fakes. Out of scope: serving the
sandbox under a path prefix (SvelteKit's base path is fixed at build time
and the app has about a hundred root-relative links; a second build would
double the package), fake-infra's own page through production (its links
are for the tunnel), signing in to the sandbox with production's session.

## Decision
- **Production knows where its sandbox is:** `GRANARY_SANDBOX_URL`
  (default `http://127.0.0.1:3100`, the port `granary sandbox init` uses;
  empty turns it off; must be a loopback URL). A sandbox has none.
- **It checks before it forwards:** the sandbox's `/healthz` says
  `sandbox: true`. Production forwards only to an answer that says so, never
  to another granary.
- **Admin → Sandbox** (Simulate group, every environment): whether a sandbox
  answers, an **Enter the sandbox** button, and otherwise the exact setup
  commands with this instance's origin filled in. The "Not available here"
  note of Fake GitHub, Fake infra and the load tester points to it.
- **Entering is a cookie, not a path:** the button (a POST, under SvelteKit's
  CSRF check) sets `granary_sandbox=1` (HttpOnly, SameSite=Lax). While it is
  set and the visitor is a **production admin**, production forwards every
  request to the sandbox, except `/__sandbox/leave` (clears it, back to
  Admin → Sandbox), the probes and `/webhook`. A visitor who is not a
  production admin (signed out, session expired) loses the cookie and gets
  production. Requests under `/__sandbox/github/` are forwarded for admins
  with or without the cookie, so links to the fake's pages work from
  anywhere.
- **Forwarding is careful:** production's own session, OAuth and sandbox
  cookies are removed; a non-GET request must come from production's origin
  (production's own CSRF check), and its `Origin` is rewritten to the
  sandbox's; `Accept-Encoding: identity`; `X-Forwarded-Host/Proto` and
  `X-Granary-Sandbox-Via: production` are added. Redirects to the sandbox's
  own origin become paths. Static assets of the same version are served by
  production itself (identical files); others fall through to the proxy.
- **The sandbox never collides with production on one origin:** with
  `GRANARY_SANDBOX=1` its cookies are named `granary_sandbox_session` and
  `granary_sandbox_oauth_state`. You sign in there separately (it runs in
  development mode: Admin → Sessions, "log in as").
- **The fake's pages, through the sandbox:** the sandbox serves
  `/__sandbox/github/*` from its fake GitHub. The fake takes
  `FAKE_GITHUB_WEB_URL`, the base of every `html_url` and of its own pages'
  links (default `FAKE_GITHUB_URL`); granary takes `GRANARY_GITHUB_PAGES_URL`,
  the base of the GitHub links it shows in the browser (default
  `GRANARY_GITHUB_WEB_URL`). Server-to-server calls keep using the loopback
  URLs.
- **`granary sandbox init --via <origin>`** writes both as
  `<origin>/__sandbox/github`: production's origin when the sandbox is used
  through production, `http://localhost:<port>` (the default) for a tunnel.
  The tunnel keeps working and needs only the app's port.
- **The whole simulation:** `granary sandbox serve` starts, as children on
  127.0.0.1, the fake GitHub, **fake-infra** (`FAKE_INFRA_HOST`) and the
  **load generator** (`LOADGEN_HOST`), each from its bundle in the package
  (`dist/fake-infra.js`, `dist/loadgen.js`), and ends when any of them
  ends. `sandbox init` (`--infra-port`, default 4090 plus the two after it
  for the exe.dev proxy fronts; `--loadgen-port`, default 4040) seeds the
  sandbox's operations module with made-up keys so its backups go to the
  fake R2 and its telemetry to fake-infra, and its allowlist with the
  personas' allowlisted logins. `sandbox serve` refuses R2 or OTLP
  endpoints that are not on this machine, and an R2 bucket without an
  endpoint override (that would be the real R2).
- **Bundling the load generator:** persona helpers that call the shared
  random helpers import them; a `declare function` made the bundler rename
  the shared ones, and the chart's embedded helper source broke.
- **Leaving:** the sandbox strip shows "Back to production" when the request
  came through production.

## Consequences
After `sandbox init --via https://granary.tinyactors.dev` and the
`granary-sandbox` unit, a production admin opens Admin → Sandbox, enters,
and uses the whole sandbox — Fake GitHub controls, the load tester and its
personas, fake infra behind its operations page, introductions, its own
activity — on production's hostname. Production's real data, webhooks and
GitHub App are untouched: the sandbox is still a separate process, data dir
and key, its GitHub is still the fake on loopback, and only production
admins get through. One browser shows either production or the sandbox at a
time (the cookie is per browser).
