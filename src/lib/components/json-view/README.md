# json-view

A standalone Svelte 5 JSON renderer: a collapsible **structure** tree and a
pretty-printed **source** view, key/path search, vim or emacs keyboard
navigation, and clipboard integration. Rows are virtualized, so documents with
tens of thousands of nodes stay smooth.

It depends only on `svelte`. Nothing here imports app code, so the folder can
be copied into another project as is. Playground: `/admin/components/json-view`
(dev mode only). Decision record: `docs/adr/0057-json-view-component.md`.

```svelte
<script lang="ts">
	import { JsonView } from '$lib/components/json-view';
	let mode = $state<'structure' | 'source'>('structure');
</script>

<JsonView value={payload} bind:mode keymap="vim" rootLabel="payload" height="24rem"
	onselect={(path, value) => console.log(path, value)} />
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `unknown` | — | Any value. JSON, plus JS values: `bigint` (shown as `123n`), `Map`, `Set`, `Date`, typed arrays, functions, cycles (`[Circular]`), `undefined`. Never cloned or mutated. |
| `mode` | `'structure' \| 'source'` | `'structure'` | **Bindable.** The cursor stays on the same node when you switch. |
| `keymap` | `'vim' \| 'emacs'` | `'vim'` | See below. |
| `expandDepth` | `number` | `2` | Containers shallower than this start expanded (the root always does). |
| `rootLabel` | `string` | `'root'` | Shown for the root node and copied as the root's path. |
| `maxStringLength` | `number` | `200` | Longer strings are cut, with a `…+N chars` pill. Enter/Space or a click shows the rest. |
| `rowHeight` | `number` | `22` | px. Virtualization uses a fixed row height. |
| `height` | `string` | `'28rem'` | CSS height of the whole component (toolbar, rows, status bar). |
| `theme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | `auto` follows the inherited `color-scheme`, or a `.dark` ancestor. |
| `preserveState` | `boolean` | `true` | When `value` is replaced (polling), expanded nodes and the cursor stay on the same paths. `false` starts fresh from `expandDepth`. |
| `onselect` | `(path: JsonPath, value: unknown) => void` | — | Called whenever the cursor moves. `path` is an array of keys and indices. |
| `class` | `string` | `''` | Added to the root element. |

The index also exports the pure helpers `buildTree`, `formatPath`, `toPointer`,
`parseQuery`, `search`, `safeStringify` and `copyText`, and the types
`JsonPath`, `JsonTree`, `NodeKind`, `ViewMode`, `Keymap` and `Action`.

## Views

- **Structure** shows one row per node: key, a type-coloured value, `{n keys}` or
  `[n items]` counts, and a key preview for collapsed objects. Badges mark
  `Set`/`Map` (native, or the actor inspector's `{"$set": …}` / `{"$map": …}`
  shapes), `Date` and `Circular`. Strings show control characters escaped (`\n`)
  so every row stays one line high. Hovering a row, or putting the cursor on it,
  shows `value` / `path` copy buttons.
- **Source** shows pretty-printed JSON with syntax colours and a line-number
  gutter. The numbers are those of the fully expanded document, so they stay
  stable while you fold. Collapsed containers fold to `{ …n keys }`; click the
  pill or the ▸ to unfold. Folding shares its state with the structure view.

## Search

The search box (`/` in vim, `C-s`/`C-r` in emacs) matches **paths**, not just
single keys:

- **Substring:** `user.login` matches `issue.user.login`. The match has to
  overlap the node's own key, so `issue` matches the `issue` node and not all of
  its descendants.
- **Fuzzy by segment:** `iss.login` or `issue/login` match `issue.user.login`.
  Query segments must appear in order in the ancestor keys; gaps are allowed.
  The last segment must match the node's own key.
- **JSON Pointer:** `/issue/user/login` works too.
- The **values** checkbox also matches primitive values (case-insensitive
  substring).

Typing jumps straight to the first match at or after where the search started
(before it, with `C-r`). The ancestors of each match expand, and the matched part
of the key is highlighted. A dropdown lists the first 200 matches with a count
(`3/17`). In the box, Enter jumps and returns to the tree, Shift-Enter or ↑ goes
to the previous match, ↓ or `C-s` to the next, Esc clears, and `C-g` clears and
puts the cursor back where it was.

## Keyboard

Click the tree, or tab to it, then:

| vim | emacs | Action |
|---|---|---|
| `j` / `k` | `C-n` / `C-p` | next / previous row |
| `l` / `h` | `C-f` / `C-b` | expand, or go to first child / collapse, or go to parent |
| `gg` / `G` | `M-<` / `M->` | top / bottom |
| `C-d` / `C-u` | `C-v` / `M-v` | page down / up |
| `zo` / `zc` / `za` | `Tab` | open / close / toggle |
| `zR` / `zM` | — | open all / close all (toolbar buttons too) |
| `/` | `C-s` / `C-r` | search forward / backward |
| `n` / `N` | `C-s` / `C-r` | next / previous match |
| `y` | `M-w` | copy value (strings raw, containers as JSON) |
| `Y` | `C-u M-w` | copy path (`issue.user.login`, `items[3]`, `["odd key"]`) |
| `yy` | `C-c w` | copy subtree as JSON |
| `yp` | `C-c p` | copy JSON Pointer (`/issue/user/login`) |
| `yd` | `C-c d` | copy whole document |
| `t` | `M-t` | toggle structure / source |
| `Esc` | `C-g` | cancel: close help/menu, clear search |

Both keymaps also get ↑ ↓ ← →, Home/End, PgUp/PgDn, Enter/Space (toggle),
Shift-F10 or the Menu key (context menu), and `?` (help overlay).

- **Pending prefix:** a waiting prefix (`g`, `z`, `y`, `C-u`, `C-c`) shows in the
  status bar. A lone `y` copies the value after 600 ms, or right away when the
  next key isn't `y`, `p` or `d`.
- **Meta is Option/Alt,** matched by physical key, so macOS Option-symbols
  still work.
- **Browser caveat:** some browsers reserve a few emacs chords outside macOS
  (`C-n` for a new window, `C-w` to close the tab) and won't pass them to the
  page. The arrow keys always work.

## Clipboard

Copy with the keys above, the row's hover buttons, the toolbar's "copy
document" button, or the right-click / Shift-F10 **context menu**. The menu
has value, path, JSON Pointer, subtree JSON, whole document, and expand/collapse
subtree. A small toast inside the component confirms each copy.

It uses `navigator.clipboard.writeText` first, then falls back to
`execCommand('copy')` for insecure origins or when permission is denied. If both
fail, the toast says "Copy failed" in red. Nothing throws.

## Accessibility

The scroll area is `role="tree"`, and each row is a `treeitem` with
`aria-level`, `aria-expanded`, `aria-selected`, `aria-setsize` and
`aria-posinset`. Focus stays on the tree and the cursor is announced through
`aria-activedescendant`. That is the pattern for virtualized trees: a roving
`tabindex` would lose focus whenever the focused row scrolls out of the DOM.
The cursor row is always scrolled into view, so the active descendant is always
rendered. The help overlay is a labelled dialog, and the context menu is a
`role="menu"` you can drive with ↑/↓/Esc.

## Theming

Styles are scoped. They read the host's shadcn tokens through CSS custom
properties, with neutral fallbacks, so the component matches the app and also
works on its own:

- **Host tokens read:** `--background`, `--foreground`, `--muted`,
  `--muted-foreground`, `--border`, `--accent`, `--primary`,
  `--primary-foreground`, `--ring`, `--popover`, `--radius`, `--font-mono`,
  `--destructive`.
- **Overrides:** set any `--jv-*` variable on a wrapper to override it:
  `--jv-key`, `--jv-string`, `--jv-number`, `--jv-boolean`, `--jv-null`,
  `--jv-other`, `--jv-hit` (search highlight), `--jv-match-row`,
  `--jv-cursor-row`, `--jv-font`.
- **Light and dark:** syntax colours use `light-dark()`, so they follow the
  inherited `color-scheme`. mode-watcher sets it in this app, and a `.dark`
  ancestor also switches to dark.

## Performance

- **No deep copy:** `buildTree` flattens the value once, in pre-order, into
  parallel arrays and typed arrays (`depth`, `parent`, `end`, `count`, `line`,
  `closeLine`, `expanded`). Nodes point at the caller's values.
- **Expansion without reactivity:** expansion state is a `Uint8Array` changed in
  place, and a revision counter tells Svelte to recompute the visible rows. No
  reactive proxies wrap the data.
- **Visible rows:** they come from a walk that skips collapsed subtrees
  (`end[n]`), which is O(visible rows).
- **Fixed-height rows:** only the rows in view, plus 10 on each side, are in the
  DOM (about 30–60 elements whatever the document size).
- **Search:** a linear pass over the precomputed paths, lower-cased once and
  cached.
- **Measured in the playground (Chrome):**

  | Action (65k nodes) | Time |
  |---|---|
  | Build the tree | about 25 ms |
  | Expand all | about 15 ms |
  | Random scroll jumps | about 16 ms per frame |
  | Search over all paths | about 30 ms |

- **Limit:** browsers cap element height (Chrome at about 33M px), so at the
  default row height about 1.5M visible rows is the practical ceiling.
