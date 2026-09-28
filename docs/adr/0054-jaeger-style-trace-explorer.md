# 54. Jaeger-style trace explorer in /__dev

Date: 2026-09-28 · Status: accepted (extends ADR 0009, 0042, 0053)

## Context
The dev console listed the newest spans as a flat table. tinyactors spans
form trees: a macrostep has microstep children, and a macrostep caused by
another actor's send is a child of the sending microstep, in the same trace
(ADR 0042). A flat list hides that shape.

## Decision
- **Server groups, client builds the tree.** A new dev query
  `listRecentTraces({limit?, family?, address?, search?})` returns
  `TraceSummary[]` (root span, services, actor addresses, event names, span,
  error and orphan counts, start, duration, linked trace ids), newest first.
  The grouping lives in `src/lib/server/trace-summary.ts` and both the real
  Tracer and the StubBackend use it. The selected trace's spans come from the
  existing `getRecentSpans({traceId, limit: SPAN_BUFFER_SIZE})`.
- **Bigger buffer.** `SPAN_BUFFER_SIZE` goes from 200 to 2000, since one
  issue flow is about 15 spans spread over 3–4 traces.
- **`SpanSummary` gains** `service` (the resource `service.name`), `links`
  (OTLP span links) and `cause: {spanId, traceId|null}`. `cause` is computed
  from `scxml.cause.{session_id,macrostep,microstep}` with tinyactors'
  `stepSpanID`. Its `traceId` is filled in at query time when the causing
  span is in the buffer. A cause or link in another trace counts towards
  `TraceSummary.linkedTraceIds`.
- **Tree rules** (`src/lib/components/dev/trace/tree.ts`):
  - Children follow `parentSpanId` and are sorted by start.
  - A trace can have several real roots (spawned, bootstrap and the first
    macrostep share one trace), and all of them are top level.
  - Spans whose parent is not in the trace sit under a synthetic "missing
    parent" node, one per missing id. tinyactors' `scxml.finished` names a
    parent step it never emits as a span, and evicted spans behave the same
    way.
- **UI** (`src/lib/components/dev/trace/`):
  - A filter row: family, debounced address and search inputs, a Live (2 s)
    toggle, and Refresh.
  - A legend and the trace list.
  - The trace header: an address chip per actor, which filters the list to
    every trace that touches that actor. The relay's reply starts its own
    trace, so this is how you get from `issue.opened` to `github.closed`.
    Linked-trace chips and Expand/Collapse all sit here too.
  - The timeline: a shared tick axis, indented collapsible rows, and bars
    positioned by start and scaled by duration. Rows are coloured by actor
    family, and error spans get the status red with an icon plus a bar in
    the left gutter.
  - Clicking a row expands the span detail inline, Jaeger-style:
    - ids with copy buttons
    - the parent and cause, which navigate to the span in this trace or
      jump to the other trace
    - attributes, with JSON-string values pretty-printed
    - events with offsets, links, and status
- **Polling keeps state.** The selected trace and span and the collapsed
  keys are component state keyed by id, so a refresh never resets them. The
  newest trace is selected automatically when nothing is selected.
- **Colours:** a fixed slot per family, taken from the validated reference
  palette (slots 1–3, which pass the all-pairs check in light and dark).
  issue is blue, allowlist orange, any other actor aqua, and spans with no
  actor neutral grey. Errors use the fixed status "critical" red
  (`#d03b3b`). Colour never carries identity alone: rows print the address,
  and there is a legend.

## Consequences
- **Wire format:** the span DTO has three extra fields. The OTLP export to
  the collector is unchanged.
- **Stub:** the StubBackend produces realistic flows: webhook, relay reply,
  destroyed, allowed, and gave-up with an error and a missing parent. A new
  flow appears every 8 s so the explorer can be built without the real
  system.
- **Relay traces stay unlinked.** They carry no cause or link (ADR 0042). To
  link them with a real span link, the relay would have to store the send's
  traceparent in the outbox.
