# 250. Closing messages are in-product Markdown templates

Date: 2026-09-28 · Status: accepted (supersedes the fixed wording of ADR 0004)

## Context
The comment granary posts when it closes an issue was a hard-coded constant.
Admins need to word it for their project, per kind (issue / pull request)
and sometimes per repository.

## Decision
- One setting, `messages.closing`, in the platform `settings` kv (ADR 0157):
  `{ issue, pullRequest, repos: { "<owner>/<repo>": { issue?, pullRequest? } } }`.
  `null` (or an absent override) means "inherit": repo override → global
  template for that kind → built-in default (`DEFAULT_TEMPLATES`, the ADR 0004
  wording, plus a pull-request variant). Repo keys are stored lower-cased.
- Templates are Markdown with a logic-less `{{variable}}` syntax (whitespace
  inside the braces allowed; no conditionals, loops or filters). Variables:
  `author`, `title`, `number`, `kind` ("issue" / "pull request"), `owner`,
  `repo`, `repository`, `url`, `association`. Unknown variables, empty `{{ }}`
  and stray `{{`/`}}` are errors at save time; so is a template over 60 000
  characters (GitHub's comment limit is 65 536; the marker needs room).
- Edited in `/settings/closing-message` (admins; read-only for others) and via
  `granary config set messages.closing '<json>'`; both go through the same
  validation (`saveClosingMessages`) and are audited as `closing-message.set`.
- `src/lib/schemas/message-template.ts` holds the model, validation and
  rendering as pure code shared by server, CLI and the browser editor.

## Consequences
The hard-coded `CLOSING_COMMENT` constant is gone. Pull-request templates are
stored and edited now and used once pull-request gating renders with
`kind: pull_request`.
