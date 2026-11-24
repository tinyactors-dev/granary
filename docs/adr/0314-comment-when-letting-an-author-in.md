# 314. Tell the author when an admin lets them in: a comment on each reopened item

Date: 2026-11-24 · Status: accepted (amends ADR 0313)

## Context
Letting an author in from Activity (ADR 0313) reopens what granary closed
on them, silently: the author sees "reopened" with no reason, next to
granary's closing comment that told them they were not allowed. An
approved introduction (ADR 0310) replies on the discussion; this path has
no discussion.

Whom it serves first: the author, who should learn they are allowed now.
Then the admin, who controls the wording. Who pays: one setting, one
template editor, one GitHub call per reopened item. Out of scope: one
summary comment for many items (each item notifies on its own thread), and
commenting when an admin adds someone on the Policy page (nothing is
reopened there, so there is nowhere to comment).

What GitHub offers: `POST /repos/{owner}/{repo}/issues/{n}/comments`, the
call granary already uses for closing comments, works for issues and pull
requests alike.

## Decision
- **One comment per reopened item.** The `reopen:<repoId>:<number>`
  effect reopens the item, then posts the comment carrying
  `<!-- granary:reopen:<repoId>:<number> -->`; on a retry it first looks
  for the marker among the item's comments (as the closing comment does),
  so a restart or a lost response never posts twice. The effect is done
  once both happened.
- **The text is a template**, setting `messages.admitted`, same syntax and
  validation as ADR 0250, variables `author`, `scope` ("this repository",
  "the repositories of <owner>", "every repository"), `repository`,
  `owner`. Default: "@{{author}}, you've been added to the allowlist, so
  this is open again. Issues and pull requests you open in {{scope}} will
  stay open." It is edited on the Policy page next to the allowlist
  (admins), with "Use the built-in comment".
- **Rendered when the action is queued** (ADR 0251): the effect's payload
  keeps the text, so retries post what the admin saw. A reopen effect
  queued before this change has none and renders the template in effect
  when it runs, as old close effects do.
- An item deleted on GitHub stays given up (ADR 0313): 404/410, from the
  reopen or the comment.

## Consequences
The author is told on the item itself, in words the admin chose. A long
list of items means as many comments; each sits on its own thread.
