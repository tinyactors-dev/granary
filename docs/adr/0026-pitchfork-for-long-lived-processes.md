# 26. Long-lived processes run under pitchfork; never kill by pattern

Date: 2026-09-28 · Status: accepted · Partially superseded by 230

## Context
An agent cleaned up its own test processes with `pkill -f fake-github/server.ts`,
which also killed the developer's `mise run dev:all` (fake GitHub, then the dev
server). Bare `&` background processes are also invisible and leak.

## Decision
- Long-lived processes are **pitchfork** daemons wrapping mise tasks.
  `pitchfork.toml` defines `fake-github` (ready on :4010) and `app`
  (`mise run dev`, ready on :5173, depends on fake-github). `mise run up` /
  `down` / `logs` wrap them; `dev:all` is an alias for `up`. Ad-hoc daemons
  (e.g. an agent's verification instance on other ports) use
  `pitchfork run <unique-id> -- mise run <task>` and are stopped by id.
- Killing processes by name or pattern is forbidden. Stop by pitchfork id (or
  a PID you started yourself). If a foreign process holds a port, use another
  port or ask.
- Test harness children (spawned and reaped by `tests/harness.ts`) are exempt.

## Consequences
The rule is at the top of CLAUDE.md. Processes are listable (`pitchfork list`)
and their logs retained (`pitchfork logs <id>`).
