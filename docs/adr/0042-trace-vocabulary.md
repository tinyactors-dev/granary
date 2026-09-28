# 42. Observable trace vocabulary

Date: 2026-09-28 · Status: accepted · Span naming superseded by 155

## Context
Tests assert on OTLP traces (ADR 0007). tinyactors' spans identify an actor
only by `scxml.session_id` / `scxml.actor` (`"slot:generation"`) and the
numeric `scxml.definition`; no span names the actor's address. Tests need to
find "`issue/<key>` reached `closed`" without reaching into the app.

## Decision
The trace sink (`src/lib/server/tracing.ts`) is installed with
`resource: {"service.name": "granary"}`, `detail: "decisions"`,
`values: true` (so event data is a JSON string cut at 256 characters). Each
pump turn's batch is decoded, **enriched**, re-encoded
(`src/lib/server/otlp-encode.ts`) and POSTed to
`$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces` (`application/x-protobuf`,
fire-and-forget, failures logged at most every 10 s). The sink's OTLP log
bytes go unchanged to `/v1/logs`. `decodeTraces` reads the result.
The sink is installed only when an endpoint is set or dev mode is on (dev
keeps the last 200 spans for `/__dev`).

### Enrichment (added by granary)
On every span whose session is a known actor:

| Attribute | Example |
|---|---|
| `granary.actor.family` | `issue` / `allowlist` |
| `granary.actor.name` | `555-2` / `main` |
| `granary.actor.address` | `issue/555-2` / `allowlist/main` |

On the `scxml.finished` span of an issue actor (from its done-data):
`granary.done.verdict` (`allowed|closed|failed|settled`),
`granary.done.reason` (`allowlist|association|not-allowed|check-timeout|already-settled|github-gave-up: <error>`),
`granary.done.delivery_id` (when known).

### tinyactors span names and attributes (as emitted by @tinyactors/node 0.1.0)
Resource `service.name = granary`; scope `tinyactors`.

| Span name | Meaning | Key attributes |
|---|---|---|
| `scxml.spawned` | actor created (boot, or the `issue` loader) | `scxml.session_id`, `scxml.actor` |
| `scxml.macrostep bootstrap` | initial macrostep | `scxml.state` = configuration after it |
| `scxml.macrostep <event>` | one external event | `scxml.event.name`, `scxml.event.data`, `scxml.state` (after; `[]` once final), `scxml.cause.*` |
| `scxml.microstep <event>` / `scxml.microstep (eventless)` | one transition set | `scxml.transition` (e.g. `["closing → closed on github.closed"]`), `scxml.state.exited`, `scxml.state.entered` (arrays of state ids) |
| `scxml.finished` | reached a top-level final state | `scxml.final_state` + `granary.done.*` |
| `scxml.destroyed` | removed (after finishing) | |

Span events `scxml.condition` (guard evaluations: `scxml.transition`,
`scxml.result`) appear on micro/macrostep spans. Integer attributes decode as
`number` (or `bigint` beyond 2^53); `scxml.session_id` is an integer.

Parent/child: a macrostep caused by another actor's send is a child of the
sending microstep (same trace), so one `issue.opened` trace contains the issue
actor, `allowlist/main`'s `allowlist.check` macrostep and the verdict. Relay
replies (`github.closed`/`github.gave-up`) and webhook posts start new traces.

### Recipes
- **Issue closed:** `name == "scxml.finished"`, `granary.actor.address ==
  "issue/<repoId>-<number>"`, `scxml.final_state == "closed"`
  (`granary.done.reason == "not-allowed"`). The entering transition is the
  span `scxml.microstep github.closed` with `scxml.state.entered == ["closed"]`.
- **Issue allowed:** `scxml.finished` with `scxml.final_state == "allowed"`,
  `granary.done.reason` `allowlist` or `association`; entered by
  `scxml.microstep allowlist.verdict` (`scxml.state.entered == ["allowed"]`).
- **Issue failed:** `scxml.final_state == "failed"`, reason `check-timeout`
  (entered by `scxml.microstep check.timeout`) or `github-gave-up: …` (by
  `scxml.microstep github.gave-up`).
- **Duplicate for a decided issue:** `scxml.final_state == "settled"`.
- **Allowlist verdict:** `allowlist/main` handles the check in
  `scxml.macrostep allowlist.check` (`scxml.event.data`
  `{"login":…,"association":…}`, `scxml.state == ["ready"]`); the verdict is
  visible on the issue actor as `scxml.microstep allowlist.verdict` with
  `scxml.event.data` `{"login":"mallory","allowed":false,"reason":"not-allowed"}`.
- **State entries in order** for an issue: filter by address, sort by
  `startTime`, flatten `scxml.state.entered`: fresh not-allowed issue →
  `restore, idle, checking, closing, closed`; restored after a crash with an
  outbox row → `restore, closing, closed`.

### Real examples (captured from the built app)
```json
{"name":"scxml.microstep github.closed","traceID":"b8fc917c5415bc08d86a71986cd115c1",
 "attributes":{"scxml.session_id":8589934593,"scxml.macrostep":4,"scxml.actor":"1:2",
  "scxml.definition":4294967296,"scxml.time":14009,"scxml.microstep":1,
  "scxml.event.name":"github.closed","scxml.event.type":"external",
  "scxml.event.data":"{\"effectKey\":\"close:555:2\",\"commentId\":1000}",
  "scxml.transition":["closing → closed on github.closed"],"scxml.transition.id":[9],
  "scxml.state.exited":["closing"],"scxml.state.exited.id":[3],
  "scxml.state.entered":["closed"],"scxml.state.entered.id":[5],
  "granary.actor.family":"issue","granary.actor.name":"555-2","granary.actor.address":"issue/555-2"},
 "resource":{"service.name":"granary"}}

{"name":"scxml.finished","traceID":"b8fc917c5415bc08d86a71986cd115c1",
 "attributes":{"scxml.session_id":8589934593,"scxml.macrostep":0,"scxml.actor":"1:2",
  "scxml.definition":4294967296,"scxml.time":14009,"scxml.cause.session_id":8589934593,
  "scxml.cause.macrostep":0,"scxml.cause.microstep":0,"scxml.final_state":"closed",
  "granary.actor.family":"issue","granary.actor.name":"555-2","granary.actor.address":"issue/555-2",
  "granary.done.verdict":"closed","granary.done.reason":"not-allowed","granary.done.delivery_id":"d-mal-2"},
 "resource":{"service.name":"granary"}}

{"name":"scxml.macrostep allowlist.check","traceID":"1ccfe9ff8f9fd755d4bae52ca2fe7cd3",
 "attributes":{"scxml.session_id":4294967296,"scxml.macrostep":2,"scxml.actor":"0:1",
  "scxml.event.name":"allowlist.check","scxml.event.type":"external",
  "scxml.event.data":"{\"login\":\"alice\",\"association\":\"NONE\"}",
  "scxml.cause.session_id":4294967297,"scxml.cause.macrostep":2,"scxml.cause.microstep":1,
  "scxml.state":["ready"],"granary.actor.family":"allowlist","granary.actor.name":"main",
  "granary.actor.address":"allowlist/main"},"resource":{"service.name":"granary"}}
```

## Consequences
- Re-encoding drops what `decodeTraces` does not surface (trace state, span
  flags, dropped counts); nothing granary or the tests read.
- Session → address comes from the done/fault hooks and, for unknown
  sessions, one scan of `system.actors()` per batch (issue name =
  `data.issueKey`). An actor spawned and destroyed without finishing in one
  turn (none today) would keep un-enriched spans.
- `scxml.event.data` is truncated at 256 characters; `issue.opened` data with
  long titles may be cut — match on `granary.actor.address`, not on it.
