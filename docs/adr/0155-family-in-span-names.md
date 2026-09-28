# 155. Actor family in span names; tinyactors name and kind as attributes

Date: 2026-09-28 · Status: accepted · Partially supersedes 42 and 62 (span naming and name-based predicates)

## Context
tinyactors names every span `scxml.<kind>[ <detail>]`: `scxml.macrostep
issue.opened`, `scxml.microstep (eventless)`, `scxml.finished`. In Tempo and
the /__dev trace viewer every row read "scxml.macrostep …", so it was hard to
see which actor did what without opening each span.

The question was whether the actor should instead be the OpenTelemetry
`service.name`. It should not:
- `service.name` identifies the *process / deployable service* (a resource
  attribute shared by every span the process emits). All granary actors run
  in one process, so they are one service (`granary`); the ops module's actors
  are a second one (`granary-ops`) because they are a separate subsystem with
  their own tinyactors System. Making each actor family a "service" would
  fabricate a service graph that doesn't exist and split one process's
  resource across many.
- Span names should be low-cardinality and describe the operation. The actor
  *family* (`issue`, `allowlist`, `backup-run`, …) is low-cardinality, so it
  belongs in the name. The actor *name/address* (`issue/1790…-42`) is
  high-cardinality, so it stays an attribute (`granary.actor.*`), as do event
  data and states.

## Decision
- Exporters rename spans of actors whose family is known:
  `scxml.<kind>[ <detail>]` → `<family> <kind>[ <detail>]`, e.g.
  `issue macrostep issue.opened`, `issue microstep (eventless)`,
  `issue finished`, `allowlist spawned`, `backup-run macrostep bootstrap`.
  Unknown family (anonymous actors) → the name is left as is.
- Every tinyactors span (known family or not) gets `tinyactors.span.name`
  (the original name) and `tinyactors.span.kind` (`macrostep`, `microstep`,
  `spawned`, `finished`, `destroyed`, …). Tooling matches on the kind
  attribute, never on the span name.
- Where: granary's tracer (`src/lib/server/tracing.ts`, which already decodes,
  labels with `granary.actor.*` and re-encodes) using
  `src/lib/trace/span-name.ts`; the ops System's trace sink
  (`src/lib/ops/system.ts`) with a wire-level `rewriteSpans`
  (`src/lib/ops/telemetry/otlp-wire.ts`) and its own copy of the rule
  (`src/lib/ops/telemetry/span-name.ts`, module boundary ADR 0080). Ops spans
  now also get `granary.actor.family/name/address` from the ops System's
  session → address map, so the trace viewer can filter them by address.
- Consumers switched to the kind: the fan-out's "always keep lifecycle spans"
  sampling rule, test predicates (`tests/traces.ts`: `isMacrostep`,
  `isMicrostep`, `isFinished` via `spanKindOf`, which falls back to parsing
  `scxml.<kind>` for unrenamed spans), and the viewer's fixtures (which apply
  the same rule).
- Not renamed: the fake GitHub, fake-infra and loadgen processes export their
  spans unchanged (`scxml.*`, no `tinyactors.span.*`); they are test/dev
  stand-ins and the predicates handle both forms.

## Consequences
Tempo's trace list and the /__dev viewer read like "issue macrostep
issue.opened → allowlist macrostep allowlist.check". Queries that relied on
`name =~ "scxml.macrostep.*"` should use `span.tinyactors.span.kind =
"macrostep"` (TraceQL) instead.
