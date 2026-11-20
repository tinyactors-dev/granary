# 300. granary runs on @tinyactors/node 0.4.0

Date: 2026-11-20 · Status: accepted

Supersedes in part: 0002 (topology), 0009 (the debugger), 0033 (addresses),
0040 (loaders and quarantine), 0056 (inspector fields), 0060 and 0071
(chart style), 0082, 0111, 0120 and 0123 (ops loaders and fault hooks),
0230 (`GRANARY_DEBUGGER`, `GRANARY_DAP_PORT`).

## Context
granary was built on `@tinyactors/node` 0.1.0: charts were TypeScript
builders whose guards and actions were closures, `createSystem` had loaders
that spawned virtual actors on mail, `send()` returned a promise of the
macrostep, `done`/`fault`/`deadLetter` hooks, synchronous `inspect()`, a DAP
debugger and `decodeTraces`. 0.4.0 (the guide: `docs/upgrade-tinyactors-0.4.md`)
is a new addon over core's host: SCXML charts with ECMAScript, a `Host` made
from compiled charts, `Actor` handles, I/O processors as objects, `onDone`,
`onError`, `onHandlerError`, `actor.ask`, `decodeTraces` without a host, and
typed methods for inspection. Nothing of 0.1.0's API is left.

Whom it serves: granary's maintainers first (dogfooding tinyactors), then
operators (the same traces, health and admin views). It costs a rewrite of
every chart and processor; the per-actor and per-event costs are the host's.

## Decision
- **Charts are SCXML built in TypeScript, one file per actor** (`src/lib/charts`):
  - `scxml` is a tagged template whose interpolations are XML-escaped;
    `chart({name, initial, helpers, data, body})` gives a `compileCharts`
    source. Event names, timeouts and addresses are interpolated from the
    TypeScript constants, so they stay single-sourced.
  - Logic that was a closure is a **helper**: a self-contained TypeScript
    function embedded in the chart (`Function.prototype.toString`). It may
    call other helpers by name; `helpers()` refuses a function whose name is
    not its key (what a bundler renaming it would cause). Shared logic stays
    single-sourced this way: the allowlist chart embeds `decidePolicy`.
  - A request/answer actor is a `handlerChart`: one state object `d` and a
    TypeScript handler per event, answered to the asker (`actor.ask`); a
    thrown error answers `{error, status: 500}`.
  - Every host compiles its charts at boot with `{ warningsAsErrors: true }`.
- **Actor names stay `<family>/<name>`.** Addresses are built with
  `Address.fromName`, which percent-encodes the `/`; `host.send` takes no bare
  name, so code uses `host.actor(name)` (or `findActor`).
- **No loaders.** Issue actors are spawned from SQLite (`issueLoaderBinding`
  as spawn params) before anything is sent to them: the webhook route, the
  boot re-send, the sweeper and the relay go through `issueActor(key)`. Ops
  spawns its non-terminal rows at boot and routes chart sends to actors that
  may not be running through a processor. Hibernation (`store`, `resident`)
  is not used: blobs do not survive a restart without a snapshot, and the WAL
  stays the source of truth (ADR 0003).
- **Ends:** `onDone(actor, donedata)` records verdicts (the donedata carries
  the issue key; the host gives no actor's name), `onError` replaces the
  fault hook (no quarantine, no release), there are no dead letters.
  `onHandlerError` logs what a processor threw. The runtime records the name
  each actor was spawned under, for the admin views.
- **Telemetry:** each host's config has `ticksPerSecond: 1000` and a
  `telemetry` encoder; the main tracer decodes each request, adds
  `granary.actor.*` from the native `tinyactors.actor.name` and
  `granary.done.*` from `onDone`, and re-encodes it for the ops fan-out.
  `tinyactors.chart.name` names a span's chart; the
  `tinyactors.definition.registered` logs are gone. A step's cause is its
  parent span.
- **Inspector:** `actor.state()`, `context()` and `get()`; the chart
  structure is read from the SCXML text. Mailbox contents, step counters,
  residency, scheduling and internal events have no source in 0.4.0 and are
  gone from the views.
- **The DAP debugger is removed** (`/admin/debugger`, `GRANARY_DEBUGGER`,
  `GRANARY_DAP_PORT`): 0.4.0 has no debug adapter.

## Consequences
- Charts lose TypeScript checking of their expressions; helpers keep it.
  A helper that reads module scope fails as `error.execution` at run time.
- Gaps reported to tinyactors: no way to read an actor's name; `host.send`
  refuses a bare name with a misleading message; `actor.terminate()` takes
  effect at the next turn, so a name still finds the old actor until then;
  `ask` has no default timeout; no OTLP encoder for an application's own
  metrics; no debugger.
