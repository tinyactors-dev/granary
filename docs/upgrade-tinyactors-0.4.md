# Moving granary to @tinyactors/node 0.4.0

Granary runs on `@tinyactors/node` **0.1.0**: TypeScript statechart
builders whose guards and actions are closures, `createSystem`, loaders
for virtual actors, `send()` promises, the `done`/`fault`/`deadLetter`
hooks, synchronous `inspect()`, the DAP debugger and `decodeTraces`.
**0.4.0** (tagged 2026-11-19) is the addon over core's host with an
application API on top: a `Host` made from its charts, `Actor` handles,
I/O processors as objects, `onDone`, `ask`, a `store`, `Spawner` and
host-free `decodeTraces`. None of the 0.1.0 API survives, and there is no
compatibility layer. 0.2.0 and 0.3.0 are skipped.

This guide replaces the 0.3.0 guide. It lists what changes, the decisions
to record as ADRs before coding, the mapping per call site, the order of
the work and what to report back. It is a plan, not a decision: granary's
rule is one ADR per decision, so each recommendation becomes an ADR when
it is taken. Before the first release granary keeps no backward
compatibility: rename and replace, with no shims.

**Availability.** 0.4.0 is tagged in the repository, but npm serves only
up to 0.3.0: its publish is staged, waiting for approval on npmjs.com.
Approve it before step 1. Until then, a build of
`tinyactors/tinyactors-napi` (`mise run build`) loads from the checkout.

Sources:
- The package README (now grouped as the application API, operating a
  host, and the wire format) and its guides, especially
  `docs/guide/missing-actors.md`, `io-processors.md`, `hibernation.md`
  and `telemetry.md`. The guides ship in `node_modules/@tinyactors/node`;
  the reference is the doc comments in its `index.d.ts`.
- The 0.4.0 "Upgrading" section of tinyactors-napi's `CHANGELOG.md`.
- An inventory of every granary call site (made for the 0.3.0 guide;
  granary's code has not changed since).
- A spike against a 0.4.0 build under Bun ("Verified facts").

## What changes in kind

| 0.1.0, as granary uses it | 0.4.0 |
|---|---|
| Charts are TypeScript builders (`statechart<D>()…`). Guards, assigns, data and targets are closures that import granary code. | Charts are **SCXML text** with ECMAScript expressions as strings, compiled by `compileCharts` (or `compileDir`). They run in the host's one shared `node:vm` context and cannot reach the application's modules. |
| `createSystem(options)`, then `define` | `new Host(charts, {system, config, ioProcessors, log, telemetry, onDone, onError, onHandlerError, …})`. The charts are given when the host is made; `system` is the system's name. |
| `done` hook: `{actor, finalState, data}` | **`onDone(actor, donedata)`** with the chart's `<donedata>`, or `await actor.done`. |
| `fault` hook, quarantine, `release()` | **`onError(actor, error)`**: an actor that faulted *and ended*. There is no quarantine and no release. A failing action raises `error.execution` in the chart. |
| `deadLetter` hook | None. A send from a chart to a missing actor raises `error.communication` (with its `sendid`). From granary's code, `actor.send` and `host.send` throw `StaleError`. |
| `setLoader(family, …)`: mail to an absent name spawns the actor from SQLite | **No loaders.** The package offers three patterns (`missing-actors.md`): the actor never ends and hibernates; an I/O processor routes the send and spawns on a miss; the sender handles `error.communication`. |
| `system.post`, `system.send(...)` → `Promise<SendResult>` (`until`) | `actor.send(event, data, {traceparent})` returns nothing; the event is queued or the call throws. **`actor.ask(event, data, {signal})`** resolves with the chart's reply `[event, data]`. |
| `IOProcessor.send(request, ctx)` | An object `{ receive(send) }`. `send` carries `host`, `sender` (an `Actor`), `event`, `data`, `target`, `sendid`, `traceparent`, `answer()` and `fail()`. It is **stale after `receive` returns**, unless `receive` returns a promise. |
| A processor that throws: the actor gets `error.communication`. | Same for the actor, and the error goes to **`onHandlerError(error, effect)`**. Without that hook it rejects `idle()` or ends the process. |
| `{family, name}` addresses; targets `#_actor_<family>/<name>` | `tinyactors://<system>/@<name>`. Names are **percent-encoded**, so use `[A-Za-z0-9._~-]` only: `issue.<repo>-<n>`, not `issue/<repo>-<n>`. |
| `actor.inspect()`, `system.actors()`, `mailbox()`, `definitions()`, `stats()`, `actor.data()` (synchronous) | Promises: `actor.state()`, `actor.context()`, `actor.get()`, `host.actors({chart})`, plus `actorList`, `hostStats` and `hostConfig` for operators. There is no mailbox content, no definition list and no live data root. |
| `prepareReplacement(...).activate()` | `host.addImage(newImage)`, then spawn the new version under the same name (names find the newest version first), or `host.migrate({chart, session})`. |
| `setTraceSink`, `decodeTraces`, `stepSpanID`, `metricsToOTLP` | The `config.telemetry` map plus a `telemetry(signal, bytes)` handler; `traceConfigure`/`traceWatch`; **`decodeTraces(bytes)` without a host**, with `resource`, `scope` and `links`; `host.metrics()` for the host's own counters. |
| `createDebugSession`, `DAPReader`, `encodeDAPMessage` | **None.** |
| Values crossed by reference | Values are **copied**, from the value table only: no `Date`, `Map` or class instances. Sessions (`actor.id`) are `bigint`s, while typed-method results hold them as numbers. |
| CommonJS, `version` | **ESM only**, Node ≥ 22.3, Bun. `version` is exported again. |
| `TinyactorsError.code` (`'not-found'`, `'closed'`) | `StaleError`, `StateError`, `InvalidError`, `UnsupportedError` (subclasses of `TinyactorsError`); `error.status` is core's name for the status. |
| `clock: 'manual'` | `SimulatedClock` with `increment(ms)`. The host clock's default tick is a nanosecond, so set `config.system.ticksPerSecond: 1000` and give `telemetry.flushInterval` in ms. |

## Verified facts (spike, 2026-11-20, a 0.4.0 build under Bun)

The spike ran granary's issue and allowlist flow with a `granary:policy`
processor, a `github` processor, four issues and a `SimulatedClock`.

- **Done results.** `onDone(actor, donedata)` received
  `{verdict: 'allowed'|'closed'|'failed', reason, deliveryId}` from
  `<final><donedata><content expr="…"/></donedata></final>`.
  - A final state with no donedata gives `undefined`.
  - The `Actor` has no name property, so **donedata must carry the
    issue key**, as `IssueDoneData` already does.
  - `actor.done` resolves the same way.
- **Processor errors.** A `github` processor that threw gave the actor
  `error.communication`, and `onHandlerError(error, send)` received the
  error and the view. The process went on and `idle()` resolved.
- **Chart helpers.** A chart-level `<script>` with `function
  closeRequest(issue, deliveryId) {…}` compiled with no diagnostic and
  was callable from `<content expr>`. Helpers are shared by all sessions
  and take what they read as arguments.
- **Names and addresses.**
  - A chart's `target="tinyactors://granary/@allowlist.main"` delivered,
    and the reply with `targetexpr="_event.origin"` reached the issue.
  - `host.actor('issue.12-3')` of an ended actor throws `StaleError`.
  - **`host.send` does not take a bare name.** `host.send('present.1', …)`
    throws `InvalidError` ("the address names no local session") even
    for a live actor. A full address of a missing name throws
    `StaleError`. Use `host.actor(name).send(...)`.
- **Ask.** `actor.ask('ping', 21)` resolved with `['pong', 42]` from a
  chart that answered `_event.origin`.
- **Traces.**
  - `decodeTraces(bytes)` without a host gave every span with
    `resource: {'service.name': 'granary'}`.
  - `scxml.finished` spans carry `tinyactors.actor.name` and
    `scxml.final_state`.
  - Span names and `scxml.*` attributes are granary's vocabulary (ADR
    0042, 0062), so the test predicates carry over.
- `version` is `'0.4.0'`.

## Decisions to record (ADRs) before coding

1. **How charts are written. Recommended: SCXML template literals in TypeScript, one file per actor.**
   - `issue.ts` exports `issueChart(): Source` built with a small `scxml`
     tagged template. The template XML-escapes interpolated values and
     interpolates `EVENTS.*`, timeouts (`delay="${CHECK_TIMEOUT_MS}ms"`)
     and addresses (`Address.fromName(SYSTEM, 'allowlist.main').text`).
   - This keeps the one-file-per-actor rule and single-sources the
     constants with `schemas/actors.ts`. Nothing has to be shipped in the
     CLI bundle or the release pack.
   - Each system compiles its charts once at boot with
     `compileCharts(sources, {warningsAsErrors: true})`. Expressions that
     do not parse, and top-level `let`/`const`/`class`/`var`, fail boot.
   - The alternative is `.scxml` files compiled with `compileDir`. It
     gives editor support, but the files have to ship and the constants
     are duplicated.
2. **Logic that lives in TypeScript stays there.**
   - Policy shared with the UI and catch-up (`decidePolicy`) becomes a
     synchronous processor, `granary:policy`, that answers in `receive`
     (verified above).
   - Shaping that only one chart needs (`closeRequest`, the ops
     `breached`/`nextAction` checks, the loadgen RNG) becomes chart-level
     `function` helpers that take what they read as arguments.
   - Session state lives in `<data>`. Never declare top-level
     `let`/`const`/`class`.
   - `Date.now()` works in a chart but ignores a `SimulatedClock`. Pass
     times in event data where a test steps the clock.
3. **Names: `<kind>.<ids>`, unreserved characters only.**
   - `issue.<repoId>-<number>`, `allowlist.main`, `delivery-catchup.main`,
     `condition.<id>`, `backup-run.<id>`, `upload.<runId>.<destId>`,
     `delivery.<guid>`, `repository.<owner>.<repo>` and so on. Check every
     id that comes from GitHub or a user against `[a-z0-9-]` (lowercase it)
     before it becomes part of a name.
   - A name must never equal a chart's name: an unnamed actor is indexed
     under its chart's name.
   - This replaces granary's `{family, name}` `ActorAddress` type and
     `actorTargetUri`/`opsTargetUri` with `Address.fromName(system, name)`.
     The schemas, the WAL's `reply_to`, the admin routes
     (`/admin/actors/[family]/[name]`) and the trace enrichment all change
     with it.
4. **Actors that are not there (no loaders).** Choose per kind of actor,
   following `missing-actors.md`:
   - **Issues:** the application routes them.
     - `postIssueOpened` and the relay's replies call
       `ensureActor('issue', key)`. It runs `host.actor(name)` and, on a
       `StaleError`, `host.spawn('issue', {name, params: issueParams(wal,
       key)})` with today's `issueLoaderBinding`, then `.send(...)`.
     - Boot spawns every issue with a pending inbox or outbox row. The
       `restore` router states keep working: `params` set the `<data>`
       before the first step.
   - **Singletons** (`allowlist.main`, `delivery-catchup.main`, the fakes'
     registries) never end and are spawned at boot.
   - **Ops conditions, backup runs and uploads** are routed.
     - Boot spawns the non-terminal rows (`OpsFeature.loaders` becomes
       `OpsFeature.resume(host, db)`).
     - Processors that posted to such names (`sample` → `condition.*`,
       `backup-ledger` → `upload.*`) use `ensureActor`.
     - Chart-to-chart sends to actors that may not be there (retention →
       `upload.*`, upload → `backup-run.*`) go through an `ops:route`
       processor that runs `ensureActor` and forwards with `{origin:
       send.sender.address}`, as `missing-actors.md` shows.
   - Short-lived targets (fake deliveries, persona actors) let the sender
     handle `error.communication`.
   - **`store`/`resident`:** not needed at granary's scale, and blobs do
     not survive a restart without a `snapshot()`. Granary's SQLite stays
     the source of truth. Revisit as a dogfooding step once the move is
     done.
5. **Done persistence: `onDone`.**
   - Each issue `<final>` has `<donedata>` with today's `IssueDoneData`.
     `onDone` validates it with the typebox schema and calls
     `wal.recordDone` and `tracer.noteDone`, as the hook does today.
   - Ops keeps persisting through its ledger and journal processors.
   - Loadgen's `finished: 'retain'` is gone. Each persona's `<final>`
     puts its snapshot in `<donedata>`, and `onDone` freezes it.
   - An actor ends at its `<final>`, and events still queued for it are
     dropped. Pending HTTP waits in the fakes must be answered before
     then (decision 6).
6. **Request and reply: `ask` instead of `reply` processors.**
   - The fakes' `reply` processor and `reqId` maps (about 40 `ask()` and
     `waitForReply` call sites) become
     `await actor.ask(event, data, {signal: AbortSignal.timeout(5000)})`.
     The chart answers with `<send targetexpr="_event.origin">`.
   - The same pattern covers ops `condition.acknowledge` and loadgen's
     scenario control.
   - An ask whose actor ends without answering never settles, which is
     why the signal is required. Record the timeout per call site.
   - Admin `devSendEvent` (`until: 'completed'`) becomes `actor.send`,
     then `await actor.state()`, reported as "accepted"; nothing waits
     for a macrostep.
7. **Faults and handler errors.**
   - `onError(actor, error)` replaces the `fault` hook for actors that
     end on a fault.
   - `onHandlerError(error, effect)` logs through granary's logger,
     counts, and keeps the process up.
   - Charts get `error.execution` and `error.communication` transitions
     where 0.1.0 relied on quarantine.
   - The "quarantined" figures in admin and ops become `hostStats()`'s
     `charts[].{errorsExecution, errorsCommunication, faults}`.
8. **The debugger (ADR 0009) is removed.**
   - Remove `dap.ts`, `DevDebugger.svelte`, `/admin/debugger`, its
     capability and `GRANARY_DEBUGGER` (ADR 0230).
   - Stand-ins: `traceWatch` (full detail for one actor for a while) and
     `actor.state()`/`context()`/`get()` in the inspector.
9. **The actor inspector (ADR 0056, 0057).**
   - Snapshots come from `actor.state()` (`value`, `history`),
     `actor.context()` (`variables`) and `actor.get()` (`chart`, `segment`,
     `mailbox` count, `invocations`, `timers` with `due` in `host.now()`
     ms).
   - Lists come from `host.actors({chart})` and `actorList`.
   - Gone: microstep position, mailbox contents, internal events,
     definition ids and revisions, residency and scheduling.
   - Chart structure (`chart-structure.ts`, `ChartTree`) is read from the
     SCXML text granary builds (decision 1). That needs a small XML walk:
     Bun has no `DOMParser`, so pick a tiny dependency or hand-roll one,
     and record which.
10. **Telemetry.**
    - Per host:
      ```js
      config: { system: {ticksPerSecond: 1000}, telemetry: {flushInterval: 1000, values, resource: {'service.name': …}} }
      ```
      Set `detail` with `host.traceConfigure({detail: 'decisions' | 'summary'})`.
    - Granary's `Tracer` keeps its decode → enrich → re-encode path, now
      decoding with `decodeTraces`.
      - `tinyactors.actor.name`, `tinyactors.chart.name` and
        `tinyactors.span.kind` are native, so `granary.actor.*` reduces to
        parsing the actor name (`<kind>.<ids>`).
      - `granary.done.*` comes from `onDone`.
    - `DecodedSpan`'s shape changed. Port `otlp-encode.ts`,
      `request-log.ts` and the trace UI (`tree.ts`):
      - `trace`/`span`/`parent` instead of `traceID`/`spanID`/`parentSpanID`.
      - `start`/`end` in ns (`number | bigint`).
      - `kind` and `status` as OTLP numbers, plus `statusMessage`.
      - `resource` as a flat map, `scope`, and `links` with `trace`/`span`.
    - `stepSpanID` is gone. The cause is the span's parent (or
      `scxml.cause.*` with `linkParents`).
    - The `tinyactors.definition.registered` logs read by `tests/otlp.ts`
      are gone: use `tinyactors.chart.name`.
    - Ops filters by `tinyactors.chart.name === 'telemetry-sink'` instead
      of definition ids.
    - Ops' own gauges (`metricsToOTLP`) need granary's encoder;
      `host.metrics()` covers only the host's counters.
    - Close hosts with `await host[Symbol.asyncDispose]()` at shutdown so
      the last spans flush.

## Simplifications beyond the port

These are found by a review of granary against 0.4.0 (2026-11-20). They
are things granary can delete or shrink, not just port. Line counts are
approximate.

Overall, about 1,500 to 1,900 lines go, in the order below. Two things do
**not** get simpler:

- **The SQLite WAL.** Every table has a reason beyond 0.1.0:
  - `inbox`: committed before the 2xx, deduplicates by delivery id, and
    feeds the catch-up GUID check and the activity UI.
  - `outbox`: at-most-once comments through `comment_id` and the marker
    search.
  - `verdicts`: the `settled` phase and the activity view.

  `snapshot()` does not replace any of it. A snapshot is refused across
  builds (every deploy), and refused while a handler's promise is
  pending. The snapshots guide says it is not a backup. Snapshots would
  add a second recovery path and remove none.
- **The fakes and loadgen** stay separate HTTP processes. That is their
  purpose (ADR 0060, 0070, 0130): they exercise granary's real GitHub, S3
  and OTLP clients, HMAC and SigV4 signing, and SIGKILL recovery. The stub
  layer (`*.stub.ts`, about 1,700 lines) is the UI seam of ADR 0032, not
  a tinyactors workaround.

### High confidence

1. **Both tracers forward OTLP bytes untouched (about 500 lines).** Core
   now writes `tinyactors.actor.name`, `tinyactors.chart.name` (a span
   attribute) and `tinyactors.span.kind`.
   - **Ops loop breaking.** One core rule replaces the session map,
     `nameSpan`, `excludeFromTraces`, the definition-id filter and the
     filter/rewrite half of `ops/telemetry/otlp-wire.ts`
     (`spanFacts`, `filterSpans`, `traceSampled`, `rewriteSpans`, about
     260 lines):
     ```js
     traceConfigure({detail: 'summary', rules: [{chart: 'telemetry-sink', sample: 'drop'}]})
     ```
     Verified on a 0.4.0 build: the rule drops the sink's steps, including
     a step continuing another actor's trace, the processor's answer and
     its timers. Only the sink's one `scxml.spawned` record is left. Keep
     the redaction half of `otlp-wire.ts` (ADR 0093): core does not
     redact, and granary exports `values: true`.
   - **Main Tracer enrichment.** Delete `addressOfInspection`, the session
     map, `noteActor`, `#enrich` (`granary.actor.*`) and the
     `stepSpanID`-based `causeOf` (about 120 lines). The cause is the
     span's parent.
     - Move `granary.done.*` to `onDone`: a log record, or a `<log>` in
       the final state.
     - Drop the ADR 0155 renaming to `<family> <kind> …` (the
       `trace/span-name.ts` pair and `applyFamilySpanName`, about 80
       lines). Tooling matches on `tinyactors.span.kind`, which was ADR
       0155's goal; amend ADR 0155.
     - The export path then neither decodes nor re-encodes. The /admin
       ring buffer still decodes with `decodeTraces`. `otlp-encode.ts`
       stays for the HTTP server spans (ADR 0234) and ops metrics.
   - **Tests.** Delete the `families` map fed by
     `tinyactors.definition.registered` logs (`tests/otlp.ts`), and
     `guessFamily`/`nameFor` and the dual-form kind parsing
     (`tests/traces.ts`), about 70 lines. Keep the protobuf *logs*
     decoder: `decodeTraces` reads traces only.
2. **The debugger goes (about 400 lines).** `dap.ts`, `DevDebugger.svelte`,
   `LaunchConfig.svelte`, the route, `getDapLaunchConfig` in four places,
   `dapHost`/`dapPort`, and `GRANARY_DEBUGGER` in the config schema and
   ADR 0230. This is decision 8.
3. **The fakes' reply machinery becomes `ask` (about 260 lines).**
   - **Deleted:** `fake-github/io/reply.ts` and its near-identical copy in
     fake-infra (pending maps, `ask`, `waitForReply`, `rejectAllPending`,
     `answer()`), and every fake chart's `out` field. The 51 `answer()`
     sites become `<send targetexpr="_event.origin">`.
   - **Error answers need care.** Today `answer()` turns a script error
     into `{error, status: 500}`. In 0.4.0 a failing script raises
     `error.execution`, so the ask would wait until its signal fires.
     Each fake chart keeps the pending request's origin in `<data>` and
     answers it from an `error.execution` transition.
   - **Delivery chart:** `reqIds` shrinks to a list of waiting origins,
     answered with `<foreach>`.
4. **The inspector shrinks (about 220 lines).**
   - `inspect/snapshot.ts` goes from 135 to about 50 lines: mailbox
     contents, `definitions()`, position, current and internal events and
     slot origins have no source in 0.4.0.
   - `SnapshotView.svelte` loses those sections, and `backend.stub.ts`
     loses their fakes.
   - `inspect/json-safe.ts` goes from 92 to about 30 lines, because values
     are plain: no `Map`, `Date`, functions or cycles. Keep bigint
     handling and size caps.
   - Lists use `actorList`/`hostStats`, not one async `state()` per actor.
5. **Quarantine and dead letters go (about 90 lines).**
   - **Main and ops systems:** the fault hooks that destroy actors so a
     loader reloads them, the `deadLetter` hooks and counters, and
     `stats.deadLetters`.
   - **Health:** `countQuarantined` and its cache, the
     `actors-quarantined` condition, and the `granary_quarantined_actors`
     and `granary_dead_letters` gauges.
   - **Replacements:** `onError`, `hostStats().charts[].faults` and
     `errorsCommunication`, and `host.metrics()` for both hosts. The
     condition becomes "faults since the last sample", because the
     counters are monotonic.

### Medium confidence (a design change; record an ADR)

6. **The relay's scheduler becomes chart-level retries (about 180 lines).**
   - **Deleted:** the claim/pump/timer/backoff loop in `relay.ts`, and
     `claimDue`, `resetInflight`, `nextOutboxDueAt`, `markOutboxRetry` and
     the `inflight` state in `wal.ts`.
   - **The `github` processor becomes async.** It inserts or reads the
     outbox row, makes one attempt (marker search, comment, close),
     updates the row, and answers `github.closed` or `github.failed
     {retryAfterMs}`.
   - **The issue chart's `closing` state** counts attempts in `<data>`,
     arms a delayed `<send>` for the backoff, and goes to `failed` after
     the maximum.
   - **Kept:** the outbox row, `comment_id`, marker adoption and the
     done/dead fast path.
   - **Lost or changed:**
     - The global limit of 4 in flight; a semaphore in the processor
       restores it.
     - The retry schedule across a crash: boot respawns pending issues in
       `closing`, which retry at once.
     - The admin "retry effect" action becomes an event to the issue.
   - **This changes ADR 0041.**
7. **Delete the 30 s inbox sweeper; keep the boot re-post (about 25 lines).**
   - **Why it can go:** the sweeper exists for queue-full (ADR 0003), and
     0.4.0 queues grow. A send lands, or throws `StaleError`, which
     `ensureActor` handles.
   - **What closes the remaining gaps:** pending rows left by an ignored
     duplicate or by events dropped at the final state are closed by
     marking the key's pending inbox rows `done` in `wal.recordDone`.
   - **Why the boot re-post stays:** in-flight actors are still lost on a
     restart.
8. **Chart structure is read from SCXML (about 70 lines, up to 250).**
   - **Deleted:** the regex parsing of closure source
     (`chart-structure.ts`) and the `BUILDERS` registry with its revision
     check (`charts.ts`).
   - **Replacement:** a small walk over the SCXML granary builds, with
     real expressions and lines.
   - **Option:** show the SCXML source itself and drop `toChart` and
     `ChartTree.svelte`. Loadgen and its stub use `toChart` too.
9. **Loadgen's persona bookkeeping goes (about 50 lines net).**
   - **Deleted:** `finished: 'retain'`, the slot/generation matching and
     `addressOfActor`. `onDone` carries the persona id and final snapshot
     in donedata.
   - **Shrinks:** `reply()` and `sourceKey` become `send.answer`.
   - **Cost:** the live persona snapshots become async, and so do
     `summary`, `listPersonas` and `getPersona` with their callers.

### Looked at and kept

- **Redaction (ADR 0093).** Core has no redaction.
- **Multiple sinks and per-sink budgets.**
- **The telemetry-sink actor and `otlp` processor** (buffer,
  drop-oldest, backoff, circuit, 4 MiB split). The guide leaves retries
  to the exporter.
- **Tail-style sampling that always keeps error and lifecycle spans.**
  Core rules decide when a trace starts, so `traceConfigure({sample})`
  can replace only the head ratio.
- **Watchdog, conditions and remediations other than quarantine.** They
  are domain checks.
- **`issueLoaderBinding` and the `restore` router states.** They become
  spawn `params`.
- **The test harness's processes, SIGKILL and collector.**
- **`loadgen/observer.ts`.**
- **Ops metrics.** `metricsToOTLP` is gone, so ops gauges need a granary
  encoder next to `otlp-encode.ts`, about 60 lines added.

## Mapping, call site by call site

### Systems → hosts (5)

| System | 0.4.0 |
|---|---|
| main (`src/lib/server/system.ts`) | `new Host(compileCharts([issueChart(), allowlistChart(), deliveryCatchupChart()], {warningsAsErrors: true}), {system: 'granary', config, ioProcessors: {github, 'github-app': catchup, 'granary:policy': policy}, onDone, onError, onHandlerError, telemetry, log})`. Boot spawns `allowlist.main` and the pending issues. `delivery-catchup.main` is spawned when the GitHub mode becomes `app`. |
| ops (`src/lib/ops/system.ts`) | Its own host (system `granary-ops`) in the same process. Features contribute `ioProcessors` objects and chart sources. `loaders` becomes `resume`. Drop `OpsFeature.invokers`, which nothing uses; 0.4.0 calls them `services`. |
| fake-github, fake-infra | One host each. `reset()` becomes `for (const a of await host.actors()) a.terminate()` (or close and make a new host), then the singletons are spawned again. |
| loadgen | One host. Personas report through `onDone` with donedata (decision 5) and are matched by `String(actor.id)` or name, not by `slot`/`generation`. |
| `tools/release/verify-inside.ts` | `const {Host, version} = await import(...)`; `new Host([], {system: 'smoke'}).close()`; print `version`. |

### Chart features

| Builder | SCXML |
|---|---|
| `.data('k', v)` | `<data id="k" expr="…"/>`. A loader `binding` becomes spawn `params`; keys that name no `<data>` are ignored. |
| `.state`, `.final`, `.initial` | `<state>`, `<final>`, `initial=`. fake-github's delivery chart, which has no `.initial`, takes the first child state. |
| `.on(e, t => t.when(c).target(s).assign(k, f))` | `<transition event="e" cond="…" target="s"><assign location="k" expr="…"/></transition>`, tried in document order. Event names match by prefix, word by word, so an answer must not extend its request's name. |
| `.always(...)` | An eventless `<transition cond="…" target="…"/>`. |
| `.internal()` | `type="internal"`. |
| `.entry` / `.exit` | `<onentry>` / `<onexit>`. |
| `.send(e, b => b.to(uri).data(f))` | `<send event="e" target="tinyactors://granary/@allowlist.main"><content expr="…"/></send>`, or `<param>`s. `targetexpr="_event.origin"` for replies. |
| `.send(...).via('github')` | `<send type="github" event="…">`. The type must be a key of the host's `ioProcessors`; otherwise the chart gets `error.execution`. |
| `.id(x).after(ms)` / `.cancel(x)` | `<send id="x" delay="10000ms"/>` / `<cancel sendid="x"/>`. A computed delay is `delayexpr="ms + 'ms'"`; a bare number raises `error.execution`. |
| `.raise` / `.choose(c, then)` | `<raise event>` / `<if cond>`. |
| `.script(function () { this.x… })` | `<script>x = …</script>`. Variables are plain names, never `this.` or `ctx.data.`. |
| `.doneData(d => d.content(fn))` | `<donedata><content expr="…"/></donedata>`, which goes to `onDone`. |
| `literal(x)` | An expression literal. |
| `event.data`, `event.origin` | `_event.data`, `_event.origin`. An origin is either a full address or a fragment `#_scxml_<n>`: key tables by the fragment (`missing-actors.md`, "Keying a table by the sender"). |
| Persona helpers (`rnd`, `between`, `chance`, `pickOf`) | Chart-level `function` helpers. The RNG state stays a `<data>` passed in and assigned back. The text generators stay in TypeScript behind loadgen's `host` processor. |

### I/O processors (13 implementations)

Every processor becomes an object with `receive(send)`:

- `request.event` → `send.event`.
- `request.data` → `send.data`.
- `request.source` → `send.sender` (an `Actor`).
- `ctx.post(source, …)` → `send.answer(event, data)` (also later when
  `receive` returns a promise), or `send.sender.send(...)` /
  `ensureActor(...).send(...)` from anywhere.
- `ctx.system` → `send.host`. `ctx.signal` → granary's own
  `AbortController`, aborted at shutdown.
- Bad input → `send.fail()`. A throw also fails the send, but it reaches
  `onHandlerError` as an error.

Per processor:

- **`github`** (main):
  - The outbox's `reply_to` stores the issue **name**, not a session:
    sessions do not survive a restart.
  - The relay replies with `ensureActor('issue', key).send(...)`. The
    "already done" fast path is `send.answer(...)`.
- **`github-app`**, **`otlp`**, **`remediate`**, **`snapshot`**,
  **`object-store`**: async. Return the promise and answer through the
  view; it is filled before the host moves on. A rejection before an
  answer fails the send and goes to `onHandlerError`, so catch inside
  where the chart should get a domain event instead.
- **`journal`**, **`backup-ledger`**: synchronous SQLite writes.
  `backup-ledger`'s post to `upload.*` goes through `ensureActor`.
- **`sample`**: `ensureActor('condition', 'condition.<id>')` + send.
- **The fakes' `reply`**: removed, replaced by `ask` (decision 6).
- **`webhook`** (fake-github): async fetch, then `send.answer('webhook.result', …)`.
- **loadgen `github` / `host`**: the same pattern.

### Sending and handles

| 0.1.0 | 0.4.0 |
|---|---|
| `system.post(addr, e, d, {traceparent})` | `host.actor(name).send(e, d, {traceparent})`, inside `ensureActor` where the actor may be absent. Never `host.send(name, …)`: a bare name is refused (verified). |
| `await system.send(..., {until, timeout})` | `await actor.ask(e, d, {signal: AbortSignal.timeout(ms)})` where the caller needs an answer; otherwise `actor.send`. |
| `system.flush()` | `await host.idle()`, in tests and shutdown only. |
| `system.findActor(addr)` / `exists` | `host.actor(name)` (throws `StaleError`) / try-catch around it. |
| `actor.destroy()` / `system.destroy` | `actor.terminate()`. |
| `actor.data()` (fakes) | `await actor.context()`, a copy. |
| `system.time`, `delayedSends[].due` | `host.now()`, `(await actor.get()).timers[].due`. |
| `stats().messages.*`, `memory.total.bytesInUse` | `hostStats()`: `host.*` counters, `pools[]`, `charts[]`. There are no message-queue counters; memory comes from the pools' `slabBytes`. |
| `ActorID {slot, generation}` | `actor.id` (`bigint`); `actor.equals(other)`. Key maps by `String(actor.id)`. |
| `prepareReplacement(def, {binding}).activate()` (`backups/runtime.ts`) | Terminate and spawn under the same name with params. Or, as a dogfooding step, add the new image and spawn its version under the name ("Updating through names"). |

### Packaging

- `package.json`: `"@tinyactors/node": "0.4.0"`, pinned exactly while
  dogfooding and kept in `dependencies` (ADR 0022's reason still holds).
  Run `bun install` and check that `bun.lock` lists the four platform
  packages at 0.4.0.
- `vite.config.ts` (`ssr.external`, `optimizeDeps.exclude`), mise.toml's
  `--external @tinyactors/node` and `tools/release/pack.ts`: no change.
  Check that `bun --bun vite dev` and the built server load the ESM
  package.
- `src/cli/commands.ts`: `(await import('@tinyactors/node')).version` works
  again.
- `tools/release/verify-inside.ts`: switch to a dynamic `import()`.

## Order of work

Each step ends green (`mise run test`) and is one or more conventional
commits. Steps 2 to 6 replace a whole system at a time, so no step runs
two APIs.

1. **ADRs, dependency and tooling.**
   - Write the ADRs for decisions 1 to 10.
   - Approve the staged 0.4.0 on npm.
   - Add the `scxml` tagged template, `ensureActor`, the name helpers
     (`<kind>.<ids>`, id validation) and the `DecodedSpan` port of
     `otlp-encode.ts`.
2. **fake-infra, then fake-github.** These exercise `ask`, singletons and
   `reset()`. The integration tests drive them unchanged.
3. **Main system.**
   - Charts: issue, allowlist (with `granary:policy`) and
     delivery-catchup.
   - Wiring: `onDone`, boot-time spawning of pending issues instead of
     the `issue` loader, the relay through `ensureActor`, and the Tracer
     on the telemetry handler.
   - Run the policy, pull-requests, closing-message, blocklist, crash and
     github-app tests.
4. **Ops.**
   - The 10 charts, `resume` instead of `loaders`, and `ops:route`.
   - Replace `prepareReplacement` in `backups/runtime.ts`.
   - Filter the fan-out by chart name.
   - Run the ops-backups and faults tests.
5. **Loadgen.** The scenario and 9 personas (`declareBase` becomes a
   shared SCXML fragment), with persona results through `onDone`. Run the
   load test.
6. **Admin and inspector.**
   - `Actor` methods in `backend.real.ts`, `inspect/snapshot.ts` and the
     remote functions; routes keyed by name.
   - Chart structure from SCXML.
   - Remove the debugger.
   - Check `/admin/actors` and the trace explorer with `agent-browser`.
7. **Packaging and docs.**
   - `verify-inside.ts`, the release pack and its verify step.
   - The ADR index, with superseded ADRs marked.
   - Update CLAUDE.md, which still names `System.setTraceSink` and the
     debugger.

## ADRs this supersedes or touches

- **Superseded, wholly or in part:**
  - 0002: topology.
  - 0009: the debugger.
  - 0033: protocol. Names and addresses change.
  - 0040: boot, loaders and quarantine.
  - 0056: inspector fields.
  - 0060, 0071: chart style.
  - 0082, 0111, 0120, 0123: ops loaders and the fault hook.
  - 0155: native attributes.
  - 0200
- **Revisited:**
  - 0003: the loaders' role. The WAL stays; tinyactors state is still in
    memory only.
  - 0042 and 0062: the vocabulary is unchanged, and the log-based
    definition map is dropped.
  - 0121: the definition-id filter.
  - 0135
  - 0230: removes `GRANARY_DEBUGGER`.

## Feedback on the 0.3.0 guide: what 0.4.0 addressed

| Reported | In 0.4.0 |
|---|---|
| No `version` export; `package.json` not exported | Both fixed. |
| No callback when an actor ends | `onDone`, `actor.done`, `onError`. |
| No completion signal for a send | `actor.ask` gives request and reply. There is still nothing that waits for a macrostep to finish (`until: 'completed'`); `ask` covers granary's uses. |
| Actors on demand | No fallback by design. `missing-actors.md` gives three patterns, and `Spawner` and `store`/`resident` support them. |
| `traceSpansDecode` needs a host and drops resource, scope and links | `decodeTraces(bytes)`, with all three. |
| A processor's throw ends the process | `onHandlerError`. |
| Per-session vm context for declaring scripts | Gone: one shared context, chart-level helpers. |
| Names with `/` silently unaddressable | Documented, with a naming convention. There is still no compile-time warning. |
| No OTLP encoder for application metrics | Not addressed. |
| No debugger | Not addressed. |

## New findings to report

- `host.send(name, …)` with a bare name throws `InvalidError`, "the
  address names no local session", even when that name's actor is live.
  A full address of a missing name throws `StaleError`. `host.actor`
  takes bare names, so the asymmetry is easy to trip on, and the message
  misleads. Either accept names in `host.send` or say "not an address".
- `missing-actors.md` says a send from the program to a missing actor
  throws `StaleError`. That holds for `actor.send` and a full address,
  not for a bare name (above).
- An `Actor` handed to `onDone` has no name property. Applications that
  key their records by name must repeat the name in `<donedata>`.
- `ask` has no default timeout, so an actor that ends without answering
  leaves the promise pending for ever. A required or default timeout, or
  a rejection when the asked actor ends, would remove a footgun.
