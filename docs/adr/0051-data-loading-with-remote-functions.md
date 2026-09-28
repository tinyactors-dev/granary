# 51. Data loading with remote functions

Date: 2026-09-28 · Status: accepted

## Context
The UI talks to the backend only through remote functions (ADR 0023, 0031).
With async Svelte, queries can be awaited in markup; with SSR, a
`<svelte:boundary>` that has a `pending` snippet renders **the pending snippet
instead of the content** on the server.

## Decision
- **Await in markup, inside a boundary.** Pages create query instances in the
  script (`const q = getOverview()` or `$derived(getIssue({issueKey}))`) and
  render `{@const x = await q}` inside `<svelte:boundary>` with a `failed`
  snippet (`ErrorAlert` with the HTTP status, message and a "Try again" that
  calls `q.refresh()` + `reset()`).
- **Server-rendered first paint, skeletons only for lazy content.** Top-level
  boundaries have no `pending` snippet, so SSR ships real data and client
  navigation waits for it like a `load`. `pending` skeletons are used only for
  content that appears after hydration: extra "Load more" pages and the
  per-actor launch configuration. Refreshes keep the old data and show a
  spinning refresh icon (`q.loading`).
- **Filters live in the URL** (`?state=`, `?verdict=`), rendered as link tabs
  (`FilterTabs`), so they work without JS, survive reloads and are shareable.
- **Cursor pagination = one query per page.** `PagedTable` keeps a list of
  cursors `[undefined, c1, c2…]` and renders `load(before)` for each; "Load
  more" appends the last page's `nextCursor`. Every page is an ordinary cached
  query instance (refreshable, deduplicated). `{#key filter:generation}`
  resets it; the Refresh button bumps `generation`.
- **Mutations**:
  - forms (`addAllowedUser`, `devLoginAs`, `devOpenIssue`, `devInjectFault`)
    use `form.enhance(async ({submit}) => …)`; `submit()` resolves `true` on
    success and `false` on validation issues, which are shown per field with
    `fields.<name>.issues()` and form-level with `fields.issues()`. Thrown
    errors are caught and toasted (otherwise SvelteKit shows the error page).
    One remote form object is attached to exactly one `<form>`; the dev quick
    login buttons set the `login` field and `requestSubmit()` that form.
  - commands (`removeAllowedUser`, `retryEffect`, dev commands) are awaited
    in handlers with sonner toasts. `retryEffect(...).updates(...)` passes the
    visible `listEffects` pages or the `getIssue` instance so they refresh in
    the same response (single-flight, ADR 0031); others rely on the server
    refreshing the right queries.
- **Polling** (`/actors`, dev spans) is a `$effect` with `setInterval(q.refresh, 2000)`
  gated by a `Switch`; `query.live` is not used (ADR 0031).
- Relative times re-render from a shared clock (`clock.svelte.ts`,
  `createSubscriber`, 10 s tick) and carry the absolute time in `title`.

## Consequences
First paint needs the backend: a slow query delays the page (no streaming).
If streaming becomes important, move the slow part into its own boundary with
a `pending` snippet, accepting that it is not server-rendered.
