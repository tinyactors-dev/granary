# 57. A standalone JsonView component

Date: 2026-09-28 · Status: accepted

## Context
Several places show structured data: the actor inspector's data model
(`src/lib/components/actors/JsonTree.svelte`), span attributes in the trace
explorer (`SpanDetail.svelte`), and issue payloads. Each uses its own ad hoc
tree. None of them is searchable or usable from the keyboard, and none scales
to large documents. The developer wants one proper JSON renderer: a
structure/source toggle, key search over the flattened tree, vim and emacs
navigation, and clipboard integration.

## Decision
- **Where it lives:** `src/lib/components/json-view/` is a **standalone**
  component. Its only dependency is `svelte`: no shadcn components, no app
  schemas, no third-party libraries. It ships `JsonView.svelte`, the pure
  modules `tree.ts`, `keymap.ts` and `clipboard.ts`, `index.ts` and a README.
  The folder can be moved into its own package later without changes.
- **Data model:** flatten once, in pre-order, into parallel arrays and typed
  arrays.
  - The subtree of node `n` is `n..end[n]-1`.
  - Expansion is a mutable `Uint8Array`, and a revision counter drives
    recomputing the visible rows.
  - The caller's value is never cloned, and no reactive proxy wraps it.
  - Non-JSON JS values (bigint, Map, Set, Date, cycles) are displayed rather
    than rejected. The actor inspector's `{"$set": …}` and `{"$map": …}` shapes
    get badges.
- **Virtualization:** rows have a fixed height, and only the window plus
  overscan is rendered. Strings show control characters escaped so every row
  is one line. Long strings expand inline and scroll sideways.
- **Two views of one tree:**
  - Structure and source share the expansion state and the cursor. The cursor
    is a node id; in source mode a closing-bracket line selects its container.
    Switching modes centres the cursor's node.
  - Source line numbers are those of the fully expanded document, so they stay
    stable while folding.
- **Search** matches paths:
  - a substring that must overlap the node's own key segment;
  - a segment-ordered fuzzy match with gaps (`iss.login` finds
    `issue.user.login`);
  - JSON Pointer queries.

  Values are also searched when a toggle is on. It is incremental: it jumps to
  the first match from where the search started, expands the ancestors and
  highlights the matched part of the key.
- **Keymaps** are data (`keymap.ts`): a pure `resolveKey(event, keymap,
  pending)` returns an action and the next pending prefix.
  - vim: `g`, `z` and `y` prefixes. `y` alone copies the value after 600 ms or
    when an unrelated key follows.
  - emacs: `C-u` and `C-c` prefixes, and Meta chords matched by `event.code`
    so macOS Option symbols work.
  - The help overlay and the playground's cheat sheet render from the same
    tables.
- **Accessibility:** `role="tree"` with **`aria-activedescendant`** rather than
  a roving tabindex. With virtualization the focused row can leave the DOM, so
  focus stays on the tree container and the cursor row is always scrolled into
  view (and therefore rendered).
- **Clipboard:** `navigator.clipboard.writeText`, then `execCommand('copy')`.
  Failures show in an in-component toast instead of throwing. There is no
  dependency on the app's sonner toaster.
- **Theming:** scoped CSS reading the shadcn tokens (`--background`,
  `--primary`, …) through `--jv-*` variables with fallbacks. Syntax colours
  use `light-dark()`, following the inherited `color-scheme` (mode-watcher
  sets it) or a `.dark` ancestor. A `theme` prop can force either.
- **Playground:** `/__dev/components/json-view`. It is dev-only because
  `/__dev/**` returns 404 outside dev mode. It has representative datasets
  (webhook payload, deep nesting, 12k and 65k nodes, unicode/RTL/long strings,
  bigint, inspector shapes, live JS values with a cycle), a paste box, prop
  controls and a keybinding cheat sheet.

## Consequences
- **Integration is left for later:** the component is not wired into the
  existing pages yet. Natural next steps:
  - replace `src/lib/components/actors/JsonTree.svelte` in `SnapshotView.svelte`
    (the data model card), keeping the diff view as it is;
  - render JSON-valued span attributes (`scxml.event.data`, `scxml.state.*`) in
    `src/lib/components/dev/trace/SpanDetail.svelte` with a compact
    `JsonView` (`height` about 12rem, `expandDepth` 1);
  - show the stored payloads on `/issues/[key]`.
- **Row height:** a fixed row height rules out wrapped multi-line values.
  Long strings scroll horizontally, or can be copied.
- **Size ceiling:** browsers cap element height, so about 1.5M visible rows at
  22 px is the practical limit.
