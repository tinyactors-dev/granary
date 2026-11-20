# 310. Introductions through GitHub Discussions

Date: 2026-11-20 · Status: accepted

## Context
granary closes issues and pull requests from people who are not allowed.
Until now the only way in was an admin adding a login to the allowlist by
hand; nothing told the person how to ask. The maintainer wants a way to
work through people who introduce themselves.

Whom it serves first: the maintainer working through a queue; then the
person who was closed, who needs a place to say hello and an answer. Who
pays: one table, one actor family, one outbox effect kind, a small GraphQL
client (Discussions have no REST API), and a GraphQL subset in the fake
GitHub. Out of scope: hosting a form or recording video in granary
(GitHub lets people attach a short video to a discussion post), declining
on GitHub (a decline is quiet), and creating discussion categories.

Facts from GitHub's documentation (2026-11-20): repository Discussions are
GraphQL-only (`addDiscussionComment`, `createDiscussion`, …); **no mutation
creates, renames or deletes a `DiscussionCategory`**, and the REST
"update a repository" call does not take `has_discussions`. The
`discussion` webhook (actions `created`, `edited`, `deleted`,
`category_changed`, …) needs the app's **Discussions** permission.

## Decision
- **Where people introduce themselves:** a discussion category named
  **Introductions** (slug `introductions`) in each gated repository. An
  introduction there is about that repository. An owner (organization or
  user) can also name its **organization discussions repository** (GitHub
  backs org-level discussions with one repository; default
  `<owner>/.github`): an introduction there is about every repository of the
  owner.
- **Setup is checked, not performed.** GitHub has no API to create a
  category (or, without the Administration permission, to enable
  Discussions). granary checks each gated repository with GraphQL
  (`hasDiscussionsEnabled`, `discussionCategories`) and records the result:
  `no-access` (the installation has not accepted Discussions), `disabled`,
  `no-category`, or `ready` with the category's id. The Introductions page
  lists every repository with its state and the exact next step: a link to
  the repository's settings (enable Discussions) or to
  `/<owner>/<repo>/discussions/categories/new` with the name, emoji,
  description and format to paste. **Check again** re-runs it; a discussion
  webhook re-checks its repository.
- **Permissions:** the manifest asks for `discussions: write` and the
  `discussion` event. An existing app grants them like pull request access
  (ADR 0281): the owner edits the app, each installation accepts, and the
  Introductions page shows the steps until every installation has.
- **Inbound:** a signed `discussion` delivery in a repository whose issue
  gating is on (or the owner's org discussions repository) whose category
  slug is `introductions` (or whose name is `Introductions`, ignoring case)
  creates or updates one `introductions` row (`<repoId>-<number>`, the
  discussion's key; issues, pull requests and discussions share a
  repository's number sequence). `edited` updates the text; `deleted` and a
  `category_changed` out of the category withdraw a pending one; a
  `category_changed` into it creates one. Every other discussion is stored
  in the inbox as ignored with its reason.
- **The queue:** `/introductions` lists introductions by state (`pending`,
  `approved`, `declined`, `withdrawn`), each with the text, a link to the
  discussion, the scope (repository or owner), what the policy says about
  the author there now, and the items granary closed on them in that scope.
- **Approve** (admins) sends `introduction.approve {by}` to
  `introduction/<key>`, which sends `github.approve` to the `github` I/O
  processor. In one transaction the processor adds the author to the
  allowlist for the scope (ADR 0311), lists the items granary closed on the
  author in that scope (done `close` effects whose verdict is `closed`),
  renders the reply and writes the outbox effect `approve:<repoId>:<number>`
  (`kind = 'approve'`). The relay then reopens each item (`PATCH` state
  `open`; idempotent), and posts the reply on the discussion with
  `addDiscussionComment`, carrying the marker `<!-- granary:approve:… -->`
  (on a retry it first looks for the marker among the discussion's
  comments). Done → `github.approved` → final state `approved`; dead →
  `github.gave-up` → `failed` (retry from the admin's outbox view).
- **Decline** sends `introduction.decline {by, note}`; final `declined`;
  nothing is posted on GitHub.
- **The reply** is a Markdown template, `messages.approved` (same syntax and
  validation as ADR 0250), variables `author`, `scope` ("this repository" /
  "the repositories of <owner>"), `repository`, `owner`, `url` (the
  discussion), `reopened` (a Markdown list of the reopened items, or empty).
- **Pointing people there:** closing templates get the variable
  `introduce_url` (`<web>/<owner>/<repo>/discussions/new?category=introductions`
  for a ready repository, else the org discussions repository's when it is
  ready, else empty) and `introduce`, a sentence with that link or empty. The
  built-in default templates end with `{{introduce}}`, so a repository whose
  Introductions category is ready points people to it with no editing.
- **Actor:** `introduction/<repoId>-<number>`, spawned on demand with params
  from SQLite (restore → `deciding`, or `approving` when an `approve` effect
  exists); states `deciding`, `approving`, finals `approved`, `declined`,
  `failed`, `settled` (already decided). Its done-data writes the
  introduction's state.
- **Fake GitHub:** discussions and categories per repository, a `/graphql`
  endpoint for the operations granary uses (checked against a hand-written
  subset of GitHub's schema with `graphql-js`), `discussion` webhooks, and
  control endpoints to enable Discussions, create a category and open,
  edit, move or delete a discussion.

## Consequences
An admin works through introductions on one page and one click lets a
person in, reopens what was closed on them and tells them so on the
discussion. Each repository needs two manual steps on GitHub (enable
Discussions, add the category), which granary detects. The app asks for
one more permission.
