# 76. The dev portal is a subsection with its own navigation

Date: 2026-09-28 · Status: accepted (supersedes the single-page layout of ADR 53) · Partially superseded by 290

## Decision
Under `/__dev` the app's **left sidebar itself switches** to the dev
portal's areas (`AppShell` checks `isDevPath` + dev mode): a
"← Back to app" link at the top, then grouped links. Outside `/__dev` the
normal app nav stays as is, with its "Dev" entry. There is no second
sub-navigation bar; the top bar names the current dev area.

| Group | Path | Content |
|---|---|---|
| Console | `/__dev` | status of app / fake GitHub / loadgen / debugger, quick links |
| | `/__dev/sessions` | log in as |
| | `/__dev/github` | fake GitHub actions and state |
| Load | `/__dev/load` | scenarios: create (preset, seed, persona mix sliders, rates), start/pause/resume/stop, live metrics charts, invariants and violations with evidence, population by state, coordinator log |
| | `/__dev/load/personas` | every persona of a scenario grouped by kind, current state and last narration; plus the persona catalogue with each kind's statechart |
| | `/__dev/load/personas/[kind]/[name]` | one persona: what it is doing now, statechart with active/final state, narrated timeline (thoughts, actions, granary's reactions), its issues with outcomes and evidence, data model |
| Inspect | `/__dev/traces` | trace explorer (ADR 54) |
| | `/__dev/actors` | resident actors, DAP launch config, send event; links to the inspector |
| UI | `/__dev/ui` … | component previews (ADR 77) |

`/__dev/components/*` redirects (308) to `/__dev/ui/*`.

Loadgen data reaches the UI like everything else: remote functions
(`src/lib/remote/load.remote.ts`, dev-only) → `Backend` methods → the real
backend proxies `LOADGEN_URL` (`src/lib/server/loadgen-client.ts`); the stub
backend serves canned scenarios and personas built from the real persona
charts (`src/lib/server/loadgen.stub.ts`). Pages poll (1.5–3 s) while a
scenario is live and stop once it is finished.

Charts follow the dataviz method: stat tiles for single values; one y-axis
per chart (small multiples instead of dual axes); 2 px lines in the
validated categorical slots (blue, orange); crosshair tooltip listing every
series; legend for ≥ 2 series plus direct end labels; a table view per
chart; status (invariants) always icon + label, never colour alone.

## Consequences
The Backend is a `globalThis` singleton that survives Vite HMR, so adding
Backend methods needs a dev-server restart (`pitchfork restart`).
