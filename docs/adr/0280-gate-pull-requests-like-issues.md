# 280. Gate pull requests like issues

Date: 2026-09-28 · Status: accepted

## Context
granary closed only issues. The user expects pull requests from people who
aren't allowed to be closed too, with their own closing message.

## Decision
- **One actor family.** GitHub numbers issues and pull requests in one
  sequence per repository, so `issue/<repoId>-<number>` stays unique. The
  `issue` actor, its states and its trace vocabulary (ADR 0155) are
  unchanged; `issue.opened` and `github.close` gain an optional
  `kind: 'issue' | 'pull_request'` (absent = issue, so rows written by 0.1.0
  still parse).
- **Webhooks.** `pull_request` / `opened` is gated, **drafts included** (a
  draft is still an unsolicited contribution). `reopened`,
  `ready_for_review`, `synchronize` and every other action are stored as
  ignored, mirroring the issues policy (a maintainer reopening is final).
- **Effects.** Same durable outbox, effect key `close:<repoId>:<number>`,
  marker and retries. The comment goes through the issues comments endpoint
  (works for pull requests); closing uses `PATCH /repos/{o}/{r}/pulls/{n}`
  `{state:'closed'}` (pull requests have no `state_reason`). The comment is
  the closing-message template for kind `pull_request` (ADR 0250–0252;
  repo override → global → built-in default), rendered when the outbox row
  is written.
- **Policy.** The same allowlist/association policy decides both kinds.
- **Per-repo switches.** `github_repos.prs_enabled` (migration 2, default 1)
  next to the existing `enabled` (issues). A pull request is gated only when
  the switch is on **and** the repo's installation has pull request access
  (ADR 0281); otherwise it is stored as ignored with the reason.

## Consequences
New apps (manifest) ask for `pull_requests: write` and the `pull_request`
event. Existing apps need the upgrade in ADR 0281. Loadgen personas still
open only issues; its observer ignores pull request events.
