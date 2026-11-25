---
name: fakes-first
description: Build, verify and ship a granary feature through the fakes and simulations before anything touches real GitHub or production. Use FIRST, before reading code, for any request that changes what granary does, however small or casually phrased — a new action, button or icon ("make it so that I get an icon to…"), a page, a behaviour change, anything that reads or writes GitHub (webhooks, REST, GraphQL, permissions, OAuth) or ops targets — and when asked to "build this out", "try it", "show me", record a demo, set up a sandbox, or get a change released. Covers checking what GitHub really offers, extending the fake GitHub first, integration tests through traces, a hands-on playground in /admin, browser checks and phone-friendly videos with agent-browser, the production sandbox, and pushing to main through CI.
---

# Fakes first

granary never learns about GitHub in production. Every GitHub behaviour a
feature needs exists first in the fake GitHub (`fake-github/`), is tested
against it, can be tried by hand in `/admin`, and can be played with on the
production machine in a sandbox. Only then does it ship. Follow the steps in
order; each one has caught real bugs.

## 1. Find out what GitHub really offers

Before designing, read GitHub's own documentation (a `web-fetch` agent on
docs.github.com) for every API, webhook and permission the feature needs.
Write down what is **not** possible. Example: discussion categories can
neither be created nor renamed through any API, Discussions are GraphQL
only, and enabling them needs the Administration permission. So
"set it up automatically" became "check, show the next step with links, and
re-check".

- Ask the user only about real forks in the product (scope of an approval,
  where something lives). Decide everything with a conventional answer
  yourself and say so.
- Write the ADR(s) (`docs/adr/`, next free number in the workstream's range)
  before the code: whom it serves, who pays, what is out of scope, the
  decisions. Add a row to `docs/adr/README.md` and a "Current state" line.

## 2. Extend the fake GitHub first, and commit it on its own

The fake mirrors GitHub's shapes and names exactly. A field GitHub does not
have must fail in the fake as it would on GitHub.

- **Data** lives in actors (`fake-github/actors/`, one file per actor;
  handlers and helpers are self-contained functions embedded in the chart).
  New state on an existing actor is optional (`d.x ?? default`), so actors
  spawned before keep working.
- **REST** routes in `fake-github/server.ts`: authenticate like GitHub
  (`ghs_` installation tokens must cover the repo; check the installation's
  *accepted* permission and answer `403 Resource not accessible by
  integration` without it).
- **GraphQL** (`fake-github/graphql.ts`): a hand-written subset of GitHub's
  schema with GitHub's type, field and argument names, run by graphql-js,
  answering `200` with `errors[].type` (`NOT_FOUND`, `FORBIDDEN`) as GitHub
  does. `Int` is 32-bit: fold the fake's large ids into range for
  `databaseId`.
- **Webhooks** go out through `deliverRepoEvent(event, action, payload,
  repo, number)`, which signs them for every installed app that accepted
  the event.
- **Control API** (`/__control/...`, schemas in `fake-github/schemas.ts`,
  `CONTROL_PATHS`) stands in for whatever a human does on github.com
  (create a category, open a discussion, accept permissions). Add matching
  methods to `tests/fake-github-client.ts`.
- **Web pages**: every `html_url` granary shows must open in the fake
  (`threadPage` in `fake-github/page.ts`), so links work in the playground
  and the sandbox.
- Add new event types to the fake's event log (`FakeEvent`) and make the
  load generator's observer ignore what it does not judge
  (`loadgen/observer.ts`).
- Smoke-test it with a short script against `bun fake-github/server.ts` on a
  random port. Run `svelte-check`, then commit
  (`feat(fake-github): …`).

## 3. Build the product against it

- **Actors** for anything with a lifecycle (`src/lib/server/actors/`, one
  file each; spawned on demand with params from SQLite; done-data written
  by `onDone`). Tests observe them through traces.
- **Effects on GitHub** go through the outbox: the `github` I/O processor
  writes the row in one transaction with everything decided now (rendered
  text, the list of items), and the relay carries it out idempotently
  (hidden `<!-- granary:<effect_key> -->` marker, looked up on a retry).
- **Schemas** (TypeBox) at every boundary: webhook payloads (open), request
  bodies (closed), GraphQL responses, SQLite rows and JSON columns.
- **Migrations** are appended to `MIGRATIONS` in `src/lib/server/wal.ts`;
  production has data.
- New app permissions go in `GITHUB_APP_PERMISSIONS`/`GITHUB_APP_EVENTS`;
  existing installations need the "grant access" steps in the UI.
- Background checks you start must not wedge themselves: an async IIFE that
  finishes before you store its promise leaves a stale "running" promise
  behind. Chain runs explicitly, as `IntroductionSetup.checkAll` does.

## 4. Test through the running system

No unit tests. Each feature gets `tests/<feature>.test.ts` on the harness
(`useHarness()`: the built app, the fake GitHub, and an OTLP collector).

- Drive with the fake's control API; assert on traces
  (`h().waitForSpan(actorFinished(address, 'approved'))`), on the fake's
  state (`h().fakeGithub.state()`), on server-rendered pages
  (`h().fetchApp(path, { headers: { Cookie } })`) and with remote commands
  (`remoteCommand(h(), cookie, page, name, arg)`). Get an admin cookie with
  `runCli(h(), ['login-link', 'admin', '--json'])` + `consumeLoginLink`.
- Wait for what you assert, never for time: if one observable trails
  another (a counter updated after the response that produced the data you
  waited for), wait for that one too. Never skip or weaken a test to make it
  pass.
- Build before testing: `mise run build` and `mise run cli` (the tests run
  `build/` and `dist/cli.js`), then `bun test tests/<file>.test.ts` while
  iterating and `bun test --parallel=4 ./tests/` (or `mise run test`) before
  every commit.

## 5. Make it playable by hand

Add controls for the new GitHub-side actions to **Admin → Fake GitHub**
(`src/lib/components/dev/DevFakeGithub.svelte`, `dev*` remote functions in
`src/lib/remote/dev.remote.ts`, `Backend.dev*` calling the control API), so
anyone can play the other side of the feature in the browser: the dev
stack, the sandbox, or a phone through a tunnel.

## 6. Look at it in a browser

- Start the dev stack with pitchfork: `mise run up` (fake GitHub :4010,
  app :5173, loadgen, fake-infra). Stop only your daemons, by id:
  `mise x -- pitchfork stop granary/app …`. Never kill by pattern.
- Vite HMR keeps the old backend instance: after changing server classes,
  `mise x -- pitchfork restart granary/app`.
- Drive it with `mise x -- agent-browser` (never Playwright): `open`,
  `snapshot -i`, `click`, `fill`, `screenshot --full`. Sign in through
  `/admin/sessions` → the `admin` button. `find role button click --name X`
  matches partial names, so click by CSS selector or `data-testid` when a
  name could be ambiguous.

## 7. Record a video when asked (phone friendly)

- `agent-browser set viewport 412 860`, then `agent-browser record start
  <file>.mp4 --cursor` … `record stop` (ffmpeg is installed).
- Put a caption bar on each page with `agent-browser eval` (a fixed `div`
  at the bottom; add it again after every navigation), and leave 2–4 s per
  step.
- Script it (a bash file in the scratchpad), start from clean dev data
  (stop the app, remove `data/*.sqlite*`, restart; the fake forgets
  everything on restart), and **check the take before sending**:
  `ffmpeg -i x.mp4 -vf "fps=1/6,scale=206:-1,tile=6x3" -frames:v 1 sheet.png`,
  then look at the contact sheet. Re-record if a step did not happen.
- Send it with `SendUserFile` (`display: render`).

## 8. Try it on the production machine: the sandbox

Production (`ta-granary`) runs a sandbox: a second granary with the whole
simulation (fake GitHub, fake-infra, load generator) on 127.0.0.1 only
(ADR 0312, 0315, `docs/manual/sandbox.md`). Admins use it through
production: Admin → Sandbox → Enter the sandbox. Anything the fakes support
can be tried there safely; the updater restarts it onto every new version.
From a cloud session, run commands on the host through exe.dev's HTTPS API
(`POST https://exe.dev/exec`, body `ssh ta-granary <cmd>`, bearer key from
1Password item `tinyactors-exe-api-key`, read with `op … --reveal` straight
into the request, never printed).

## 9. Ship

- Small Conventional Commits straight to `main`, rebased
  (`git fetch origin main && git rebase origin/main && git push origin main`).
  The fake, the product, the playground and the docs are separate commits.
- Every push runs the `release` workflow: tests, then a release to the
  `edge` channel that production's updater installs within minutes. Check it
  with the GitHub MCP tools (`actions_list` → `list_workflow_runs`; for a
  failure, `get_job_logs` with `failed_only`, then grep the saved log for
  `(fail)` and `error:`).
- A failure in a test you did not touch is still yours to diagnose: read
  the assertion, find which two observables raced, and fix the
  synchronization (or the bug). Tell the user what happened to the release.
- Update the manual (`docs/manual/`, `mise run docs:cli` after CLI changes)
  and the env table in ADR 0230 for new variables.

## Traps already hit

- mise's default backend failed to install pitchfork: it is pinned as
  `"github:jdx/pitchfork"`.
- GraphQL `Int` overflow from the fake's ids broke a reply until they were
  folded into 32 bits.
- A finished-before-stored async IIFE left a setup check "running" forever.
- `find … --name "Open"` clicked the wrong button and the first video
  showed nothing; selectors fixed it.
- An ops telemetry test read a counter before the sink had updated it: CI
  failed once and blocked a release.
