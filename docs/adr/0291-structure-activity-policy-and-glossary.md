# 291. Structure: Activity, Policy, one glossary, one header, one banner

Date: 2026-09-28 · Status: accepted · Supersedes the navigation parts of 0050 and the banner placement of 0100/0104

## Context
The design audit found three names for every part of the pipeline
(Deliveries/Inbox/"Webhook inbox", Effects/Outbox/"GitHub outbox",
Verdicts/"Decisions per issue"), three near-identical tables of the same
items, a top bar that repeated each page's description, banners stacking on
every page, and policy split between the main nav (allowlist) and Settings
(closing message).

## Decision
- **Glossary** (`src/lib/components/app/glossary.ts`), used for everything a
  user reads:
  - **Item** — an issue or a pull request.
  - **Delivery** — a webhook GitHub sent about an item.
  - **Decision** — allowed, closed or failed, and why (reason labels, not codes).
  - **Action** — what granary does on GitHub for a closed item: comment, then
    close.
  - **Activity** — the list of items with their deliveries, decision and action.

  Internal names (inbox, outbox, verdict, effect, actor, macrostep) stay in
  code, the database, logs, traces and the admin section.
- **Main navigation, six items:** Overview, Activity, Policy, Ops, Settings,
  Admin (admins only, ADR 0290).
- **Activity** (`/activity`) replaces `/deliveries`, `/effects` and
  `/verdicts` (308 redirects): one row per item — kind (Issue/PR), item,
  author, outcome, time — filterable by outcome (`allowed`, `closed`,
  `failed`, `closing`, `pending` shown as "Deciding", `ignored`) and kind.
  `Backend.listActivity` / `listActivity` query; the WAL computes the outcome
  per item (decision if any, else `closing` while an action exists, `ignored`
  when every delivery was ignored, else `pending`). The item page
  (`/issues/[key]`) is the detail view: Decision, GitHub action (with a link
  to the posted comment and retry), the comment text, and every delivery.
  Deliveries that aren't about an item (installation events, pings) are no
  longer listed in the UI.
- **Policy** (`/policy`): Allowlist & blocklist, and the closing message
  (moved from Settings; `/allowlist` and `/settings/closing-message` redirect).
- **Headers:** the top bar names the section only; each page's `PageHeader`
  carries the title and description, so nothing is said twice. Policy, Ops and
  Settings use one `SubNav` component.
- **Banners, at most one per page:** the setup banner while GitHub isn't
  connected (not on /settings or /admin); otherwise "While you were away" on
  the Overview only and only when something needs attention — what ops
  handled on its own is on /ops, whose hero already says whether all is well.
- The Components sidebar lists every component preview (it missed the
  closing-message editor).

## Consequences
Fork A (naming/copy) applies the glossary to the remaining pages (Ops,
Settings, audit log, verdict reasons elsewhere); `StateBadge` and
`FilterTabs` accept labels for that.
