# 2. Actor and I/O processor topology

Date: 2026-09-28 · Status: accepted

## Context
granary receives GitHub `issues` webhooks and closes issues opened by users
not on an allowlist. It is built on `@tinyactors/node`: statecharts as actors,
I/O processors for side effects, loaders for on-demand actors.

## Decision
One tinyactors `System` per app process, created once (a `globalThis`
singleton so Vite HMR does not create a second one).

Actors (one file each in `src/lib/server/actors/`):

| Address | Lifetime | Role |
|---|---|---|
| `allowlist/main` | spawned at boot, binding from `allowed_users` table | answers `allowlist.check {login, association}` with `allowlist.verdict {allowed, reason}` to `event.origin`; `allowlist.replace {logins}` swaps the set |
| `issue/<repoId>-<number>` | virtual: spawned by the `issue` family loader on first mail, destroyed on finish | per-issue decision + progress |

Issue chart: `restore → idle → checking → (allowed | closing → closed | failed)`,
plus `settled`. `restore` routes on the loader's `binding.phase`
(`new | closing | settled`). `closing` ignores duplicate `issue.opened`.
The check has a 10 s delayed-send timeout.

I/O processors:
- `github` (durable): on `send`, `INSERT OR IGNORE` an outbox row keyed
  `close:<repoId>:<number>` and commit, then kick the relay. If the row is
  already `done` it replies `github.closed` immediately.
- default `scxml` for actor↔actor mail.

The **outbox relay** is plain async TypeScript, not an actor: it claims outbox
rows, performs GitHub REST calls, and replies to the row's `reply_to` address
with `github.closed` or `github.gave-up` via `system.post`.

System hooks: `done` → one transaction writes `verdicts` and marks the
triggering inbox row `done`; `fault` → inbox row `failed`.

Address names use numeric `repository.id` (`issue/123456-42`) because `/` and
`#` clash with `#_actor_family/name` target URIs.

## Consequences
Actor state is small and fully derivable from SQLite; nothing depends on
tinyactors' process-local session images for durability.
