# 295. Tables stack into cards on phones

Date: 2026-09-29 · Status: accepted

## Context
The design audit found that at 390 px every table (Activity, Policy, Ops,
Settings, Admin) showed only its first column: state, reason and time sat
off-screen in a horizontally scrolling container with no hint that more was
there. Rewriting each table as a separate mobile layout would double the
markup of ~20 tables.

## Decision
- The shared shadcn `Table.Root` takes a `stack` prop. Below the `md`
  breakpoint (`width < 48rem`) a stacked table renders each row as a card:
  the first cell is the card's title, every other cell a line
  "label  value" with the values right-aligned; the header row is hidden.
- Labels come from the column headers automatically: `Table.Root` copies
  each `<th>`'s text into its column's cells as `data-label` (a
  MutationObserver keeps rows rendered later labelled). Pages only opt in.
- Escape hatches, all data attributes: a header's `data-stack-label=""`
  suppresses the label; a cell's `data-stack="hide"` hides it on phones,
  `data-stack="full"` spans the card (used by empty-state rows, set
  automatically for a full-width `colspan`), `data-stack="title"` makes that
  cell the card title instead of the first one. Hand-written tables (the
  trace list) opt in by adding `data-stack-table` and `data-label`s.
- Each stacked cell is a two-column grid (label | values); a cell with
  several values (e.g. destination name + kind) stacks them in the value
  column instead of squeezing them side by side.
- The CSS is unlayered, so it wins over the cells' utilities (`p-2`,
  `whitespace-nowrap`) on phones only; desktop and tablet tables are
  unchanged. Block-mode title cells reset `justify-items`, because Chromium
  now applies it to block layout too.
- Every table in the app opts in. `tests/responsive.test.ts` fails if a
  rendered table on a main route is not stacked.
- Long identifiers use `ShortId` (first 8 characters, full value in the
  tooltip, icon button to copy it) instead of overflowing a column.

## Consequences
Phones show every column of every table without horizontal scrolling. A new
table must pass `stack` (the test guards the main routes). Layout itself is
verified manually with agent-browser at 390, 768 and 1440 px, light and dark
(no page-level horizontal overflow on any route at the time of writing).
