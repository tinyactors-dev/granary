# 313. Let an author in from Activity: allowlist them and reopen what was closed

Date: 2026-11-24 · Status: accepted (builds on ADR 0310 and 0311)

## Context
An admin looking at Activity sees an item granary closed and decides its
author should have been let in. Until now that took three steps on two
pages (Policy: add to the allowlist, maybe unblock; then reopen each item
by hand on GitHub), or an introduction the person had to write first.

Whom it serves first: the admin working through Activity. Who pays: one
outbox effect kind (`reopen`), one Backend method, one remote command, one
icon per closed row. Out of scope: posting a comment on the reopened items
(the reopening itself notifies the author), and the item detail page.

What GitHub offers (docs.github.com, 2026-11-24): `PATCH …/issues/{n}`
with `state: open` reopens an issue and answers `410 Gone` when the issue
was deleted, `301` when it was transferred, `404` without read access;
`PATCH …/pulls/{n}` reopens a pull request. Reopening sends the app the
`issues` / `pull_request` `reopened` webhook for its own change. GitHub
does not document when reopening a pull request fails (a deleted head
branch is the likely case), so the fake does not model it.

## Decision
- **The action:** on an Activity row whose outcome is `closed`, admins get
  an icon ("Let them in"). It opens a dialog to choose the allowlist scope
  (ADR 0311): **the item's repository** (the default), **every repository
  of its owner**, or **everywhere**. Non-admins see the icon disabled.
- **One transaction** (`Backend.admitAuthor`, remote command
  `admitAuthor {issueKey, scope}`): the author comes from the item's close
  effect (so granary must have closed it: `conflict` otherwise); an active
  block is lifted (an admin letting someone in overrides it, ADR 0260);
  the allowlist entry is added with the note `activity <owner>/<repo>#<n>`;
  and for every item granary closed on the author within the scope (done
  close effect, verdict still `closed`, as for introductions) a
  `reopen:<repoId>:<number>` outbox effect is written. Then
  `allowlist.replace` (and `blocklist.replace`) are posted and the relay
  kicked. Asking again is idempotent; a `reopen` effect that gave up is
  retried.
- **The relay** carries out a `reopen` effect with the same idempotent
  PATCH introductions use (`state: open`), then, in one transaction, sets
  the verdict to `allowed` with reason `admitted` ("Reopened: an admin let
  them in") and marks the row done. Nothing is posted and no actor is
  told: the row is the record, and Activity shows "Reopening on GitHub…"
  or why it gave up.
- **Gone items:** a reopen answered `404` or `410` is dead at once, with
  "deleted on GitHub (410)" / "not found on GitHub (404)": retrying cannot
  help. Every other failure is retried as a close is.
- **Restarts:** the admin's decision (block lifted, entry, one effect per
  item) is one SQLite transaction, so a kill leaves all or none of it. The
  relay carries out pending rows after a restart (in-flight rows go back to
  pending; a `Retry-After` is honoured), and reopening an open item changes
  nothing, so a lost response or a kill between GitHub's change and the
  done mark reopens nothing twice. `tests/admit-crash.test.ts` SIGKILLs the
  app before GitHub was asked, after GitHub reopened the item but before
  granary recorded it, and between two items.
- **Fakes first:** the fake GitHub delivers `closed`/`reopened` webhooks
  for REST changes, lets an admin delete an issue (then `410`), and can
  lose a response after making the change (`applied` faults). Admin →
  Fake GitHub has a Delete button and a "lose the response" fault option.
- **Audit:** one log line with `audit.action = allowlist.admit`; a lifted
  block is also written to the audit log as `blocklist.remove`.

## Consequences
One click on Activity does what an approved introduction does, without
a discussion. The outbox gains a third effect kind, keyed per item, so the
effects view and retries work for it unchanged.
