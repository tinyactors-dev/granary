# 71. Personas are statecharts

Date: 2026-09-28 · Status: accepted

## Context
Load should look like people, not like a loop: people wait, react to what
happened to their issue, escalate, give up. We also want to *see* what each
simulated person is doing and why.

## Decision
Every persona is a tinyactors actor whose chart family is its kind
(address `<kind>/<scenario>-<n>`). One file per kind in `loadgen/personas/`:

| Kind | Login / association | Behaviour (states) | Expected granary outcome |
|---|---|---|---|
| `slop-fixer` | fresh login, `NONE` | arriving → drafting → opening → lurking → (drafting …) → vanished. Opens 1–3 huge low-effort issues (pasted logs, walls of AI-ish text, emoji); ignores every notification. | closed |
| `persistent-contributor` | fresh login, `NONE`/`CONTRIBUTOR` | arriving → drafting → opening → waiting → stewing → (reopening → waitingAfterReopen \| drafting a near-duplicate) … → ragequitting → gaveUp, or content. Tone escalates with each closure; gives up after 2–4 closures. | closed; reopens stay open (ADR 0004) |
| `regular` | a login from `LOADGEN_ALLOWLISTED`, `NONE` | arriving → drafting → opening → watching → (commenting) … → done, or wronglyClosed | open |
| `maintainer` | fresh login, `OWNER`/`COLLABORATOR` | same shape as regular | open |
| `member` | fresh login, `MEMBER` | same shape as regular | open |
| `first-timer` | fresh login, `FIRST_TIME_CONTRIBUTOR` | arriving → drafting → opening → hopeful → replying → waitingPatiently → movedOn. Replies politely once after being closed. | closed |
| `bot` | `<name>[bot]`, user type `Bot` | booting → flooding ⇄ posting → sleeping. Opens 5–15 dependabot-style issues in quick succession. | closed |
| `chaos-monkey` | — | lurking ⇄ striking → retired. Injects faults and duplicate deliveries (ADR 74). | — |
| `fuzzer` | varies per case | choosing ⇄ executing → cooling → … → exhausted. Works through edge cases (ADR 74). | per case |

Mechanics shared by all kinds (`loadgen/personas/common.ts`, not an actor):
- **Randomness is data.** Each persona gets `seed` in its binding
  (derived from the scenario seed and its index) and advances a mulberry32
  state in its data model, so a scenario seed reproduces every choice.
- **Time is scaled.** Delays are `min..max` ms multiplied by the scenario's
  `timeScale`; `after(function () { return this.wait })` with a per-state
  send id, cancelled on exit.
- **Acting** is `<send type="github">` to loadgen's `github` I/O processor
  (`gh.user`, `gh.open`, `gh.reopen`, `gh.comment`, and the compound
  `gh.chaos {strike, count, retryAfter, pick}` / `gh.fuzz {case}` whose
  mechanics live in the engine so the charts stay readable); results come
  back as events (`gh.user.ok`, `gh.opened`, `gh.reopened`, `gh.commented`,
  `gh.chaos.done`, `gh.fuzz.done`, or `gh.error`).
- **Being notified**: the engine routes fake-GitHub events about a
  persona's own issues to it as `notify.closed`, `notify.comment` (comments
  by others) and `notify.reopened`.
- **Narration**: significant state entries send a human sentence to the
  `host` I/O processor ("Stewing after closure #2 — tone: annoyed"), which
  goes into the persona's timeline next to its actions and granary's
  reactions. This is what the portal shows to explain behaviour.
- Personas finish in a final state and are **retained** (not destroyed) so
  they stay inspectable; personas still alive when a scenario is stopped
  (or its drain times out) are snapshotted and destroyed, and the portal
  shows the frozen snapshot.
- Notifications about an issue that arrive before the persona learned the
  issue number (granary can close within milliseconds) are queued in the
  ledger and delivered right after `gh.opened`.

## Consequences
New behaviour = new file + registration in `loadgen/personas/index.ts`
(which also feeds the chart registry for the inspector view).
