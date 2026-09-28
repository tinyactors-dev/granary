# 62. Trace vocabulary and test predicates

Date: 2026-09-28 · Status: accepted · Name-based predicates superseded by 155

## Context
Tests assert on tinyactors spans (ADR 0007). The vocabulary was
discovered empirically with a throwaway chart (named actor, custom I/O
processor send, delayed send, final state) under
`setTraceSink(..., {detail: 'decisions', values: true})` and
`decodeTraces`, tinyactors 0.1.0.

## Decision
Spans (scope `tinyactors`, all with `scxml.session_id` (decimal string),
`scxml.actor` (`slot:generation`), `scxml.definition` (numeric id),
`scxml.macrostep`, `scxml.time`):

| Span | Meaning | Notable attributes |
|---|---|---|
| `scxml.spawned` | actor created (also by a loader) | – |
| `scxml.macrostep bootstrap` | initial macrostep | `scxml.state` = active states after it |
| `scxml.macrostep <event>` | an external event was taken | `scxml.event.name`, `scxml.event.type`, `scxml.event.data` (JSON, cut at 256 chars), `scxml.event.sendid` (delayed/identified sends), `scxml.cause.*`, `scxml.state` |
| `scxml.microstep <event>` / `scxml.microstep (eventless)` | one microstep (child of its macrostep) | `scxml.transition` (`"a → b on e"`, `"a on e"` for targetless), `scxml.state.entered`, `scxml.state.exited` |
| `scxml.finished` | top-level final state reached | `scxml.final_state` |
| `scxml.destroyed` | actor destroyed | – |

A failing `<script>` marks its microstep span `status: error` and yields
OTLP logs `tinyactors.action.failed` / `tinyactors.error.raised`.
Definitions are announced by the OTLP log `tinyactors.definition.registered`
with `tinyactors.definition.{id,family,revision,origin}`.

Spans carry **no actor address**. Resolution order in `TraceIndex`
(`tests/traces.ts`):
1. `granary.actor.family` / `granary.actor.name` added by the app's tracer
   (ADR 0042), plus `granary.done.{verdict,reason,delivery_id}` on
   `scxml.finished`;
2. family from the definition log (`service:epoch:definitionId → family`);
   heuristics as last resort (issue-only states, allowlist events);
3. name from event data: `"issueKey":"<repoId>-<n>"` or
   `"effectKey":"close:<repoId>:<n>"`; `allowlist` → `main`.

Predicates (`SpanPredicate = (span, index) => boolean`, default service
`granary`): `actorFinished(address, finalState?)`,
`actorReachedState(address, state)`, `eventDelivered(address, event)`,
`mentions(text)`, `inEpoch(n)`, `and`, `or`; helpers `finalStates(index,
address)`, `index.sessionsAt(address)` (sessions with `entered`,
`events`, `finalState`, `doneReason`), `index.describe()`.
Main-system names: `issue/<repoId>-<number>` with states
`restore, idle, checking, closing, allowed, closed, failed, settled`;
`allowlist/main`.

## Consequences
Tests stay valid if the app stops enriching spans (fallbacks), and the
same index reads the fake GitHub's spans (`service: 'fake-github'`).
