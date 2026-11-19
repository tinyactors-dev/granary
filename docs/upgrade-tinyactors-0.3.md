# Moving granary to @tinyactors/node 0.3.0

Granary runs on `@tinyactors/node` **0.1.0**: TypeScript statechart
builders whose guards and actions are closures, `createSystem`, loaders
for virtual actors, `send()` promises, a `done` hook, `inspect()`, the DAP
debugger and `decodeTraces`. Version **0.3.0** (released 2026-11-18) is a
new addon over core's host. It skips 0.2.0's API, which granary never used.
Nothing of the 0.1.0 API is left and there is no compatibility layer.

This guide lists what changes, the decisions to record as ADRs before
coding, the order of the work, and how to verify each step. It is a plan,
not a decision. Each choice it recommends becomes an ADR when it is taken,
as granary's rules require. Before the first release granary keeps no
backward compatibility: rename and replace, with no shims.

Sources:
- The package README and `docs/guide/*`. They ship in
  `node_modules/@tinyactors/node`, and the reference is the doc comments
  in its `index.d.ts`.
- The "Upgrading" section of `CHANGELOG.md` in tinyactors-napi.
- An inventory of every granary call site.
- A spike against the published 0.3.0 package under Bun ("Verified
  facts" below).

## What changes in kind

| 0.1.0, as granary uses it | 0.3.0 |
|---|---|
| Charts are TypeScript builders (`statechart<D>()…`). Guards, assigns, data and targets are closures that import granary code. | Charts are **SCXML text** with ECMAScript expressions as strings. They are compiled by `compileCharts` and run in `node:vm` contexts. A chart cannot reach the application's modules. |
| `createSystem(options)` with `io`, `done`, `fault`, `deadLetter`. | `new Host(config, options)`. The config holds `systemID`, `ioProcessors` (types), `system` and `telemetry`. The options hold handlers: `ioProcessors`, `log`, `telemetry`, `services`, `wake`, `clock`. |
| The `done` hook receives `{actor, finalState, data}`. | **No done callback.** The chart reports from its `<final>`'s `<onentry>` with a `<send>` to an I/O processor. |
| `fault` hook, quarantine, `release()`. | No quarantine. A failing action raises `error.execution` in the chart. Counters are in `hostStats().charts[].{errorsExecution, errorsCommunication, faults}`. |
| `deadLetter` hook. | None. A chart's send to a missing actor raises `error.communication` in the sender. A `host.send` to a missing name throws `TA_ERROR_INVALID`, and one to an ended session throws `TA_ERROR_STALE`. |
| `setLoader(family, …)`: mail to an absent name spawns the actor from SQLite. | **No loaders.** Granary spawns the actor before it sends (`actorByName` ?? `spawnChart(…, {name, params})`). `wake` exists only for actors the host hibernated itself. |
| `system.post` and `system.send(...)` returning `Promise<SendResult>` (`until: completed/accepted`). | `host.send(target, event, data, {traceparent})` returns nothing. The event is queued, or the call throws. There is no completion promise; `await host.idle()` is for tests and shutdown. |
| `IOProcessor.send(request, ctx)`: `request.source/event/data`, `ctx.post`, `ctx.signal`. | `(host, send) => …`. The `send` argument is a **view, stale after the handler returns** unless the handler returns a promise. Reply with `send.answer(event, data)`, which also works later from an async handler, or with `host.send(...)`. Fail the send with `send.fail()`. |
| A processor that throws: the actor gets `error.communication`. | The actor still gets `error.communication`, but **the error is also the turn's**. It rejects `idle()` or is thrown as an uncaught exception, which ends the process by default. Validation failures must call `send.fail()`, not throw. |
| Addresses are `{family, name}`; targets are `#_actor_<family>/<name>`. | Addresses are `tinyactors://<systemID>/@<name>` (the `Address` class). Names are **percent-encoded** in an address: `allowlist/main` becomes `@allowlist%2Fmain`. |
| `actor.inspect()`, `system.actors()`, `mailbox()`, `definitions()`, `stats()`, `actor.data()`: synchronous. | Typed methods that return **promises**: `actorState`, `actorContext`, `actorGet`, `actorList`, `hostStats`, `hostConfig`. There is no mailbox content, no definition list and no live data root. |
| `prepareReplacement(...).activate()`. | `host.addImage(newImage)` + `host.migrate({chart, session})` (the `migrated` and `migrationDone` handlers), or `terminate` + `spawnChart`. |
| `setTraceSink(fn, {detail, values, resource})`, `decodeTraces`, `stepSpanID`, `metricsToOTLP`. | The config's `telemetry` map plus a `telemetry: (host, signal, bytes)` handler; `traceConfigure` and `traceWatch`; `traceSpansDecode` (async, per host); `host.metrics()` for the host's own counters only. |
| `createDebugSession`, `DAPReader`, `encodeDAPMessage`. | **None.** |
| Values crossed by reference (`data` was shared). | Values are **copied**, from the value table only: no `Date`, `Map` or class instances. Sessions are `bigint`s, and typed-method results hold sessions as numbers. |
| CommonJS. | **ESM only**, Node ≥ 22.3, Bun. There is no `version` export. |
| Time in ms, `clock: 'manual'`. | Time in ms, `SimulatedClock`. The host clock defaults to **nanosecond ticks**: set `system.ticksPerSecond: 1000` so that `telemetry.flushInterval` is in ms. |

## Verified facts (spike, 2026-11-19, `@tinyactors/node@0.3.0` under Bun)

- **Span vocabulary is unchanged for granary's tests.** Core adopted
  granary ADRs 0042 and 0062 (tinyactors ADR 0006).
  - Span names: `scxml.spawned`, `scxml.macrostep bootstrap|<event>`,
    `scxml.microstep <event>|(eventless)`, `scxml.finished`,
    `scxml.destroyed`.
  - Attributes: `scxml.session_id`, `scxml.definition`, `scxml.actor`,
    `scxml.state`, `scxml.event.name`, `scxml.event.type`,
    `scxml.transition`, `scxml.state.entered/exited`.
  - Core now writes `tinyactors.actor.name`, `tinyactors.chart.name` and
    `tinyactors.span.kind` itself.
- **Delivery failures:**
  - A send from a chart to `@allowlist/main` (an unencoded slash) fails
    with `error.communication`.
  - `Address.fromName('granary', 'allowlist/main').text` is
    `tinyactors://granary/@allowlist%2Fmain`, and that address delivers.
  - `host.send` to an absent name throws `TA_ERROR_INVALID`.
- **Errors in I/O processors:** a handler that throws gives the sender
  `error.communication` and rejects `host.idle()` with the thrown error.
- **Chart data:**
  - `<content expr="helper(issue)"/>` with `helper` assigned in a chart
    `<script>` to a `<data>` delivers a plain object to the handler.
  - `Date.now()` works inside a chart. It reads the wall clock, not a
    `SimulatedClock`.
  - Spawn `params` that name no `<data>` are ignored.
- **The package has no `version` export.** Its `exports` map has only
  `"."`, so the package's `package.json` is not importable by subpath.

## Decisions to record (ADRs) before coding

Each of these needs an ADR, with the recommendation as a starting point.

1. **How charts are written. Recommended: SCXML template literals in TypeScript, one file per actor.**
   - `issue.ts` exports `issueChart(): string` built with a small `scxml`
     tagged template. The template XML-escapes interpolated values and
     interpolates `EVENTS.*`, timeouts (`delay="${CHECK_TIMEOUT_MS}ms"`)
     and encoded addresses (`Address.fromName(...)`).
   - This keeps the one-file-per-actor rule. It keeps event names and
     constants single-sourced with `schemas/actors.ts`, and it needs no
     `.scxml` files in the CLI bundle or the release pack.
   - Compile every chart of a system at boot with
     `compileCharts(sources, undefined, {warningsAsErrors: true})`, so an
     expression that does not parse fails boot rather than raising
     `error.execution` later.
   - The alternative is `.scxml` files with `directoryResolver`. That
     gives editor support, but needs file shipping and duplicates the
     constants.
2. **Logic that lives in TypeScript stays there: the chart asks an I/O processor.**
   - Closures that call granary code (`decidePolicy`, the ops
     `breached`/`nextAction` helpers, `closeRequest`) cannot be imported
     by a chart.
   - Shared policy logic such as `decidePolicy` (also used by the UI and
     the catch-up) becomes a synchronous processor (`granary:policy`).
     It answers in its handler with `send.answer('allowlist.verdict', …)`.
   - Pure data shaping that only the chart needs moves into the chart:
     a `<script>` that assigns arrow functions to `<data>` variables
     (`<data id="closeRequest"/>`, `closeRequest = (i) => ({…})`).
   - **Do not declare top-level `var`/`function`/`let`/`const` in
     scripts.** It gives each session its own vm context, about 60 KB on
     Bun and 143 KB on Node, and `let`/`const`/`class` also blocks
     hibernation and migration.
3. **Virtual actors without loaders. Recommended: everything that can receive mail is resident.**
   - At boot, spawn every non-terminal row from SQLite with its binding
     as `params`: issues pending in the inbox or outbox, ops conditions,
     backup runs and uploads. These populations are small.
   - Every host-side send goes through a helper,
     `ensureActor(chart, name, paramsFromSQLite)`, then `host.send`. This
     covers `postIssueOpened`, the relay's replies, and the
     `sample`/`backup-ledger` processors that posted to `condition/<id>`
     and `upload/<run>:<dest>`.
   - Chart-to-chart sends that relied on loading must target an actor
     that is already resident, or go through an I/O processor that calls
     `ensureActor`. In ops that is retention → `upload/<run>:<dest>` and
     upload → `backup-run/<id>`.
   - The `restore` router states (`always` on `phase`) keep working:
     `params` set the `<data>` before the first step.
   - Hibernation (`sweep`, `hibernate`, `wake`) is *not* needed at
     granary's scale. Skip it for now; it is a later dogfooding topic.
4. **Done persistence.**
   - Each chart's `<final>` sends its result to a `granary:done` (main)
     or `ops:ledger` / `ops:journal` (ops) processor, which writes SQLite
     synchronously.
   - Because the actor ends right after its `<final>`, any request still
     queued for it is dropped. Pending HTTP waits (the fakes' `reqId`
     map) must be settled from the `<final>` too (README, "When the sender
     ends").
   - `tracer.noteDone`'s enrichment of the `finished` span is fed from
     that same handler.
5. **Faults and dead letters.**
   - Remove the hooks. Add `error.execution` and `error.communication`
     transitions where 0.1.0 relied on quarantine.
   - The admin and ops "quarantined" count becomes the
     `errorsExecution`/`errorsCommunication`/`faults` counters of
     `hostStats()`.
   - Supersede the parts of ADR 0040 and 0120 that describe quarantine.
6. **The debugger (ADR 0009, `/admin/debugger`, `GRANARY_DEBUGGER`).**
   - 0.3.0 has no debug adapter. Remove `dap.ts`, `DevDebugger.svelte`,
     the route and the capability, together with `GRANARY_DEBUGGER` in
     ADR 0230.
   - Report the gap upstream as a dogfooding finding. Do not rebuild a
     debugger in granary.
   - Partial stand-ins: `traceWatch` (full detail for one actor for a
     while) plus `actorState`, `actorContext` and `actorGet` in the
     inspector.
7. **The actor inspector (ADR 0056, 0057).**
   - Snapshots come from `actorState` (`value` plus history),
     `actorContext` (`variables`) and `actorGet` (`chart`, `mailbox`
     count, `invocations`, `timers` with `due` in `host.now()` ms).
   - Lists come from `actorList` (paged, sessions as numbers) plus
     `actorByName`.
   - Gone: microstep position, mailbox contents, internal events,
     definition ids and revisions, residency and scheduling.
   - Chart structure (`chart-structure.ts`, `ChartTree`) is rebuilt from
     the SCXML text granary already holds. A small XML walk replaces the
     `DefinitionSpec` walk: Bun has no `DOMParser`, so choose a tiny
     parser dependency or hand-roll one. Record which.
8. **Telemetry.**
   - Configure per host:
     ```js
     telemetry: { flushInterval: 1000, values, resource: {'service.name': …} }
     system: { ticksPerSecond: 1000 }
     ```
   - Set `detail` with `traceConfigure({detail: 'decisions' | 'summary'})`
     after creation.
   - The handler gets OTLP bytes. Granary's `Tracer` decode → enrich →
     re-encode path needs a decoder: `traceSpansDecode` is async, needs a
     host, and returns no resource, scope or links.
   - Recommended: granary owns a small OTLP *decoder* next to
     `otlp-encode.ts`, used by the Tracer, fake-infra and `tests/otlp.ts`.
     Most of the enrichment shrinks, since `tinyactors.actor.name` and
     `tinyactors.chart.name` are now native.
   - `stepSpanID` is gone. Spans keep `scxml.cause.*`, and the cause is
     the span's parent unless `linkParents` is set.
   - The `tinyactors.definition.registered` log that `tests/otlp.ts` reads
     is gone. Map by `tinyactors.chart.name` instead.
   - Ops filtering by `scxml.definition` id becomes filtering by
     `tinyactors.chart.name === 'telemetry-sink'`.
   - Ops' own gauges (`metricsToOTLP`) need granary's encoder too. Use
     `host.metrics()` for the host's counters.
   - Call `host.close()`, or `await host[Symbol.asyncDispose]()`, at
     shutdown so that the last spans flush.

## Mapping, call site by call site

### Systems → hosts (5)

| System | 0.3.0 |
|---|---|
| main (`src/lib/server/system.ts`) | `new Host({systemID: 'granary', ioProcessors: [{type: 'github'}, {type: 'github-app'}, {type: 'granary:done'}, {type: 'granary:policy'}], system: {ticksPerSecond: 1000}, telemetry: {…}}, {ioProcessors, telemetry, log})`. Charts go in with `host.addCharts({...})`, or with one `compileCharts` at boot and then `addImage`. The allowlist and catch-up singletons use `spawnChart(name, {name, params})`. |
| ops (`src/lib/ops/system.ts`) | Its own `Host` (systemID `granary-ops`) in the same process. The features contribute `ioProcessors` handlers and `IOProcessorConfig`s. `OpsFeature.loaders` becomes `OpsFeature.resume(host, db)`, which spawns the non-terminal rows. Drop `OpsFeature.invokers`, which nothing uses; 0.3.0 calls these `services`. |
| fake-github, fake-infra | One host each. `reset()` becomes `actorList` + `terminate` for every session (or `close()` and a new host), then the singletons are spawned again. |
| loadgen | One host. `finished: 'retain'` has no equivalent, because ended actors are gone. Each persona reports its final snapshot from its `<final>` to the `host` processor, and the engine stores it. Personas are matched by name or session, not by `slot`/`generation`. |
| `tools/release/verify-inside.ts` | `const {Host} = await import(...)`; `new Host({systemID: 'smoke'}).close()`. Print the version from the resolved package's `package.json` (next table). |

### Chart features

| Builder | SCXML |
|---|---|
| `.data('k', v)` | `<data id="k" expr="…"/>`. The loader `binding` becomes spawn `params`. |
| `.state`, `.final`, `.initial` | `<state>`, `<final>`, `initial=`. fake-github's delivery chart, which has no `.initial`, takes the first child state. |
| `.on(e, t => t.when(c).target(s).assign(k, f))` | `<transition event="e" cond="…" target="s"><assign location="k" expr="…"/></transition>`. Transitions are tried in document order, as before. |
| `.always(...)` | `<transition cond="…" target="…"/>` (eventless). |
| `.internal()` | `type="internal"`. |
| `.entry` / `.exit` | `<onentry>` / `<onexit>`. |
| `.send(e, b => b.to(uri).data(f))` | `<send event="e" target="tinyactors://granary/@allowlist%2Fmain"><content expr="…"/></send>`, or `<param>`s. Use `targetexpr="_event.origin"` for replies. |
| `.send(...).via('github')` | `<send type="github" event="…">`. The type must be listed in the config's `ioProcessors`. |
| `.id(x).after(ms)` / `.cancel(x)` | `<send id="x" delay="10000ms"/>` / `<cancel sendid="x"/>`. A computed delay is `delayexpr="ms + 'ms'"`. A bare number raises `error.execution`. |
| `.raise` | `<raise event>`. |
| `.choose(c, then)` | `<if cond>…</if>`. |
| `.script(function () { this.x… })` | `<script>x = …</script>`. Variables are plain names, not `this.` or `ctx.data.`. |
| `.doneData(d => d.content(fn))` | `<donedata>` only matters to an invoking parent. Granary uses `<onentry><send type="granary:done">` in the `<final>` instead (decision 4). |
| `literal(x)` | An expression literal. |
| `EvaluationContext`, `event.data`, `event.origin` | `_event.data`, `_event.origin`, `_event.name`. |
| Closures calling `rnd`/`between`/`chance` (loadgen) | The mulberry32 RNG is written in a chart `<script>`, assigned to `<data>` (decision 2). The text generators stay in TypeScript behind the loadgen `host` processor. |
| `Date.now()` in charts | Works, but a `SimulatedClock` does not move it. Prefer passing times in event data. |

### I/O processors (13 implementations)

The common rewrite is the same everywhere:

- `request.event` → `send.event`.
- `request.data` → `send.data`.
- `request.source` → `send.session` (a bigint) or `send.origin` (an
  `Address`).
- `ctx.post(source, …)` → `send.answer(event, data)` (in the handler, or
  later when the handler returns a promise), or `host.send(...)` from
  anywhere.
- `ctx.signal` → granary's own `AbortController`, aborted at shutdown.
- `ctx.system.closed` → `host.closed`.
- `throw` for bad input → `send.fail()`; return normally.

Per processor:

- **`github`** (main):
  - The outbox's `reply_to` stores the issue **name** (`issue/<key>`),
    not the session: sessions do not survive a restart.
  - The relay replies with `ensureActor` + `host.send(name, …)`. The
    "already done" fast path is `send.answer(...)`.
- **`github-app`** (catch-up), **`otlp`**, **`remediate`**, **`snapshot`**
  and **`object-store`**: async, so return the promise and answer
  through the view, or call `host.send` later. A promise that rejects
  before an answer fails the send and is an unhandled rejection: catch
  inside the handler.
- **`journal`** and **`backup-ledger`**: synchronous SQLite writes.
  `backup-ledger`'s post to `upload/...` goes through `ensureActor`.
- **`sample`**: `ensureActor('condition', 'condition/<id>', …)` +
  `host.send`.
- **The fakes' `reply`**: resolve pending HTTP waits from the view's data.
  With no `until: 'accepted'`, the `ask()` helper checks
  `host.actorByName(name)` before `host.send` and turns a throw into the
  404 or 503 it used to give on a dead letter.
- **`webhook`** (fake-github): async fetch, then `send.answer('webhook.result', …)`.
- **loadgen `github` / `host`**: same pattern.

### Sending and handles

| 0.1.0 | 0.3.0 |
|---|---|
| `system.post(addr, e, d, {traceparent})` | `host.send(Address.fromName(sys, name), e, d, {traceparent})`, or a bare name string via the address text. Wrap it in `ensureActor` where the actor may be absent. |
| `await system.send(..., {until: 'completed'})` (admin `devSendEvent`) | `host.send` + `await host.actorState({session})` in a later turn. Report "accepted", not "completed": `idle()` on a busy server may not settle. |
| `await system.send(..., {timeout})` (ops `condition.acknowledge`, loadgen scenario control) | `host.send`. The chart answers through a processor if the caller needs a result. |
| `system.flush()` | `await host.idle()`, in tests and shutdown only. |
| `system.findActor(addr)` / `exists` | `host.actorByName(name)` (`undefined` when absent or ended). |
| `actor.destroy()` / `system.destroy` | `host.terminate(session)`. |
| `actor.data()` (fakes) | `await host.actorContext({session})`, a copy. |
| `system.time`, `delayedSends[].due` | `host.now()`, `actorGet(...).timers[].due` (ms on that clock). |
| `TinyactorsError.code` (`'not-found'`, `'closed'`) | `error.status` (`'TA_ERROR_STALE'`, `'TA_ERROR_INVALID'`, `'TA_ERROR_STATE'`). |
| `stats().messages.*`, `memory.total.bytesInUse` | `hostStats()`: `host.*` counters, `pools[]`, `charts[]`. There are no message-queue counters, and memory comes from the pools' `slabBytes`. |
| `ActorID {slot, generation}` | `bigint` session. Key maps by `String(session)`, because typed methods return sessions as numbers. |

### Packaging

- `package.json`: `"@tinyactors/node": "0.3.0"`. Pin it exactly while
  dogfooding. It stays in `dependencies` (ADR 0022's reason still holds:
  the addon is found through `createRequire`). Run `bun install` and
  check that `bun.lock` lists the four platform packages at 0.3.0.
- `vite.config.ts` (`ssr.external`, `optimizeDeps.exclude`), mise.toml's
  `--external @tinyactors/node`, and `tools/release/pack.ts`: no change.
  Check that `bun --bun vite dev` and the built server load the ESM
  package.
- `src/cli/commands.ts:270` (`version`):
  ```js
  JSON.parse(await Bun.file(join(dirname(Bun.resolveSync('@tinyactors/node', import.meta.dir)), 'package.json')).text()).version
  ```
  or report the version from `pack.ts`'s pinned manifest. Report the
  missing `version` export upstream.
- `tools/release/verify-inside.ts`: change it to a dynamic `import()`,
  since the package is ESM.
- ADR 0022, 0156 and 0184 name the platform packages: still correct.

## Order of work

Each step ends green (`mise run test`) and is one or more conventional
commits. Steps 2 to 6 replace a whole system at a time, so no step runs
two APIs.

1. **ADRs and tooling.**
   - Write the ADRs for decisions 1 to 8.
   - Add the `scxml` tagged template and an `ensureActor` helper.
   - Write a granary OTLP decoder (traces and logs, with resource) and
     move `tests/otlp.ts` and fake-infra onto it while still on 0.1.0.
     This removes `decodeTraces` from the critical path.
2. **fake-infra, then fake-github.**
   - Both are small and self-contained, and they exercise the
     reply-processor and `ask()` patterns.
   - The integration tests drive them unchanged.
3. **Main system.**
   - Rewrite issue, allowlist (with `granary:policy`) and
     delivery-catchup.
   - Add the `granary:done` processor, boot-time respawn instead of the
     `issue` loader, the relay through `ensureActor`, and the Tracer on
     the telemetry handler.
   - Run the policy, pull-requests, closing-message, blocklist, crash and
     github-app tests.
4. **Ops.**
   - Rewrite the 10 charts.
   - Features: `resume` instead of `loaders`.
   - Replace `prepareReplacement` in `backups/runtime.ts` with
     terminate + spawn. `migrate` is the dogfooding alternative.
   - Fan-out filtering by chart name.
   - Run the ops-backups and faults tests.
5. **Loadgen.**
   - Rewrite the scenario and the 9 personas through `declareBase`, which
     becomes a shared SCXML fragment.
   - Persona results come from `<final>`; there is no `retain`.
   - Run the load test.
6. **Admin and inspector.**
   - Typed methods in `backend.real.ts`, `inspect/snapshot.ts` and the
     remote functions.
   - Chart structure from SCXML.
   - Remove the debugger (decision 6).
   - Check `/admin/actors` and the trace explorer with `agent-browser`.
7. **Packaging.**
   - `verify-inside.ts` and the CLI version.
   - `mise run` the release pack and its verify step.
   - Update the ADR index (`docs/adr/README.md`) and mark superseded
     ADRs.

## ADRs this supersedes or touches

- **Superseded, wholly or in part:**
  - 0002: topology.
  - 0009: the debugger.
  - 0033: protocol. The addresses become `tinyactors://` names.
  - 0040: boot and quarantine.
  - 0056: inspector fields.
  - 0060, 0071: chart style.
  - 0082, 0111, 0120: ops loaders and the fault hook.
  - 0123
  - 0155: native attributes.
  - 0200
- **Revisited:**
  - 0003: the loaders' role. The WAL itself stays: tinyactors state is
    still in memory only unless granary adopts `snapshot()`.
  - 0042 and 0062: the vocabulary is unchanged, but the log-based
    definition map is dropped.
  - 0121: the definition-id filter.
  - 0135
  - 0230: removes `GRANARY_DEBUGGER`.

## Dogfooding findings to report to tinyactors

Each is a candidate request in tinyactors-napi's ROADMAP. Report them; do
not work around them silently.

- No `version` export, and `package.json` is not in `exports`.
- No completion signal for an application's send: no `until: 'completed'`
  equivalent, and `idle()` is host-wide. Granary's admin "send event and
  show the result" needs one.
- Actors on demand: no hook for a send to an absent name. Every
  application with a database of entities writes `ensureActor`, and
  chart-to-chart sends to such names cannot load them.
- No application callback when an actor ends (`DONE` is internal). The
  `<final>` + processor pattern works, but the chart has to repeat it in
  every final state.
- `traceSpansDecode` needs a live host and drops resource, scope and
  links. Tests and collectors decode bytes without a host.
- No OTLP metrics encoder for an application's own gauges.
- No debugger or step-level inspection, which replaces 0.1.0's DAP
  adapter.
- Names with `/` must be percent-encoded in a chart's `target`. Easy to
  get wrong; a compile-time warning for an unencoded `@a/b` would help.
- A processor that throws ends the process by default, where 0.1.0 turned
  it into `error.communication` only.
