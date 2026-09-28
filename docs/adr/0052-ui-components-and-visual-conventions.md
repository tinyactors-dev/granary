# 52. UI components and visual conventions

Date: 2026-09-28 · Status: accepted

## Decision
- App components live in `src/lib/components/app/`, dev-console components
  in `src/lib/components/dev/`; shadcn stays vendored in
  `src/lib/components/ui/` (added: `alert-dialog`, `switch`).
- `format.ts` holds UI constants (state lists typed against
  `$lib/schemas/wal` with type-only imports, so client bundles never pull in
  TypeBox), relative/absolute time, labels, `describeError`.
- `StateBadge` maps every state to one of five tones: success (done,
  allowed), warning (pending), info (inflight, closed, ready), danger (failed,
  dead, quarantined), muted (ignored, idle). "closed" is info, not danger: it
  is granary doing its job.
- Issues are shown as `owner/repo#number` + title and link to
  `/issues/<issueKey>`; keys that do not match `^[0-9]+-[0-9]+$` show a
  "Not an issue key" alert instead of calling `getIssue`.
- JSON (actor data, payloads, span attributes) is shown pretty-printed in
  scrollable `<pre>` blocks. Confirmations use `AlertDialog`; feedback uses
  sonner toasts. Stable `data-testid`s are set on key elements for tests.
- Native `<select>` styled like shadcn inputs is used in forms, because it
  works directly with remote form fields (`.as('select')`).
