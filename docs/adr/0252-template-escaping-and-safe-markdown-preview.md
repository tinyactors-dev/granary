# 252. Escaping template values and a safe Markdown preview

Date: 2026-09-28 · Status: accepted

## Context
Titles (and to a lesser degree logins) come from whoever opened the issue.
Inserted raw into a comment, a title could @-mention people, inject links or
images, raw HTML, or a fake `<!-- granary:… -->` marker that the relay's
"already commented?" search would match. The settings page needs a live,
faithful preview without an XSS hole.

## Decision
- **Values**: `title` is always escaped — Markdown metacharacters are
  backslash-escaped, `&`, `<`, `>` become entities, newlines become spaces,
  leading list/heading markers are escaped, and every `@` is followed by a
  zero-width joiner (U+200D) so it can't mention anyone; `scheme://` and
  `www.` get a zero-width space so no autolink is produced either. `author`, `owner`,
  `repo`, `association` pass through unchanged when they match GitHub's own
  charset (so `@{{author}}` still mentions the author) and are escaped like a
  title otherwise. `url` passes through only as a plain `https://` URL.
- **Preview**: the editor renders Markdown with `marked` (GFM, `breaks: true`
  like GitHub comments). It is small, isomorphic (works in SSR without a DOM)
  and lets renderer overrides do the sanitising: raw HTML is rendered as
  text, and links/images only for `http(s):`, `mailto:`, relative and `#`
  URLs. That is stricter than GitHub, so `{@html}` of the result is safe, and
  it needs no DOM-based sanitiser (DOMPurify would not run during SSR).
  `marked` is a devDependency: it is bundled into the build and adds nothing
  to the published package's runtime dependencies.
- **Component**: `src/lib/components/message-template/` (`MessageTemplateEditor`,
  `renderMarkdown`), catalogued in `/__dev/ui/message-template` with stories
  for the default, custom, invalid, pull-request, per-repo, mention-attempt,
  empty and read-only cases.

## Consequences
The preview may show raw HTML that GitHub would render (e.g. `<details>`) as
text; documented in the editor. Escaped titles look slightly different in
source but render as the literal title on GitHub.
