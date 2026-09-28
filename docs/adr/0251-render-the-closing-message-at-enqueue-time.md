# 251. Render the closing message when the close effect is queued

Date: 2026-09-28 · Status: accepted

## Context
The relay may retry a close effect for minutes (backoff, `Retry-After`,
restarts). If it rendered the template at posting time, an admin editing the
template meanwhile would change what an in-flight effect posts, and a retry
after a crash between "comment posted" and "comment id stored" could look for
a different text. The marker (`<!-- granary:<effect_key> -->`) is what makes
the effect idempotent; the text should be just as stable.

## Decision
- The durable `github` I/O processor renders the comment body from the
  templates in effect **when it inserts the outbox row**, and stores it in
  the outbox payload as `commentBody` (`OutboxPayload` = `github.close` data +
  optional `commentBody`, ≤ 65 000 characters).
- The relay posts `commentBody` + `\n\n` + marker (just the marker when the
  body is empty). Rows without `commentBody` (queued before templates
  existed) are rendered by the relay from the current setting.
- A stored template that no longer validates, or fails to render, falls back
  to the built-in default for that kind and logs a warning; a close never
  fails because of its message.
- The marker is appended by the relay, never by the template, so no template
  can remove or duplicate it.

## Consequences
Template changes apply to closes queued after the change. Tested: a template
changed while an effect is retrying still posts the old text, exactly once.
