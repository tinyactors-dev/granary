# 76. The dev portal is a subsection with its own navigation

Date: 2026-09-28 · Status: accepted (supersedes the single-page layout of ADR 53)

## Decision
`/__dev` has its own layout (`src/routes/__dev/+layout.svelte`) with a
sub-navigation, and one page per concern:

| Path | Content |
|---|---|
| `/__dev` | status of app / fake GitHub / loadgen / debugger, quick links |
| `/__dev/sessions` | log in as |
| `/__dev/github` | fake GitHub actions and state |
| `/__dev/load` | scenarios: create (preset, seed, persona mix sliders, rates), start/pause/resume/stop, live metrics charts, invariants and violations with evidence |
| `/__dev/load/personas` | every persona of a scenario grouped by kind, current state, issues and outcomes; plus the persona catalogue with each kind's statechart |
| `/__dev/load/personas/[kind]/[name]` | one persona: statechart with active state, data model, narrated timeline (its actions, granary's reactions), its issues |
| `/__dev/traces` | trace explorer (ADR 54) |
| `/__dev/actors` | resident actors, DAP launch config, send event; links to the inspector |
| `/__dev/components/json-view` | JSON viewer playground (owned by its component) |

Loadgen data reaches the UI like everything else: remote functions
(`src/lib/remote/load.remote.ts`, dev-only) → `Backend` methods → the real
backend proxies `LOADGEN_URL`; the stub backend serves canned scenarios and
personas built from the real persona charts. Pages poll (1–2 s) while a
scenario is running.
