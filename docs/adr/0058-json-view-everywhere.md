# 58. JSON view everywhere, through JsonBlock

Date: 2026-09-28 · Status: accepted

## Context
JSON was shown three different ways: a `<pre>{JSON.stringify}</pre>`
component (`app/JsonView.svelte`), a recursive `actors/JsonTree.svelte`, and
the standalone `json-view` component (ADR 0057) on the persona and scenario
pages. The first two lack search, keyboard navigation and copying, and the
old `app/JsonView` shared its name with the new component.

## Decision
- All structured data goes through `src/lib/components/app/JsonBlock.svelte`,
  a thin wrapper around `$lib/components/json-view`:
  - **presets** (`json-block.ts`): `inline` (table cells, event rows; ≤ 9
    rows, depth 1), `compact` (cards; ≤ 15 rows, depth 2), `panel` (main data;
    fixed 28rem, depth 3). Non-panel blocks size to their initially visible
    rows; the viewer's real toolbar/status height is measured after mount
    (the toolbar wraps in narrow containers).
  - **tiny values** (a primitive, or ≤ 3 flat primitives, ≤ 60 chars of
    JSON) render as one line of `<code>` — e.g. `["closed"]` in span
    attributes. `alwaysTree` opts out (main data blocks).
  - **fullscreen** button opens a 90vh dialog with the same value and mode;
    `fullscreen={false}` inside dialogs (actor quick view).
  - **keymap** is one app-wide preference (`json-prefs.svelte.ts`,
    localStorage, guarded), toggled from any block.
  - `[contain:inline-size]` so a block never widens table cells or grid
    tracks.
- `JsonView` gained `preserveState` (default on): when `value` is replaced —
  inspector live mode, trace polling — expanded nodes and the cursor are
  carried over by path instead of resetting.
- Integrated sites:

| Site | Preset |
|---|---|
| Actor inspector data model (`SnapshotView`) | panel, alwaysTree |
| Inspector completion / event data / mailbox message data | compact / inline / inline |
| Issue page live actor data and mailbox (`ActorPanel`) | compact, alwaysTree |
| Issue page outbox effect payload | compact, alwaysTree |
| Span attributes with JSON values (`SpanDetail`) | inline |
| Dev debugger send-event result | compact |
| Persona data model | compact, depth 1, alwaysTree |
| Scenario configuration | compact, alwaysTree |
| Fake GitHub → new "Raw state" tab | panel, alwaysTree |

- Kept as they are: the snapshot diff (`DataDiff`, a path list is the right
  shape), span event/link attributes (short inline `k=v`), the `launch.json`
  snippet (copy-paste text), `fake-github/page.ts` (plain HTML, no Svelte).
- Deleted: `app/JsonView.svelte`, `actors/JsonTree.svelte`, and the now
  unused `prettyJson` helper.
- `/__dev/ui/json-block` has stories for each preset, a table-cell context,
  a tiny value, and a live (polled) value demonstrating `preserveState`.

## Consequences
One JSON experience (search, vim/emacs keys, copy value/path/subtree) across
app and dev portal. Raw webhook payloads are still not exposed by any DTO;
showing them would need a Backend change.
