# 73. Observation, metrics and invariants

Date: 2026-09-28 · Status: accepted

## Decision
The engine subscribes to the fake GitHub's event stream
(`GET /__control/events`, SSE, ADR 75) and keeps, per scenario, an issue
ledger for its repository: who opened it (persona), the expected outcome,
and a timeline of `opened / closed(by) / reopened(by) / comment(by)` and
webhook delivery results. At `settling` it reconciles against
`GET /__control/state` (authoritative comment bodies).

**Expected outcome oracle** (independent of granary, ADR 4): an issue is
expected to stay *open* iff its author's login is in `LOADGEN_ALLOWLISTED`
(case-insensitive) or its association is OWNER/MEMBER/COLLABORATOR;
otherwise expected *closed*.

**Invariants** (each with a status `ok | violated | pending`, and every
violation stored with evidence: issue link, persona, the issue's timeline):

| Id | Invariant |
|---|---|
| `allowed-stay-open` | granary never closes or comments on an issue expected open |
| `single-comment` | every issue granary closed has exactly one granary comment, and it carries `<!-- granary:` |
| `close-once` | granary closes an issue at most once; after a user reopens an issue granary closed, granary does not close it again |
| `eventually-closed` | every issue expected closed is closed by granary within `closeDeadlineMs` of opening (+ `faultGraceMs` when the scenario's chaos injected faults) |
| `webhooks-healthy` | no webhook delivery to granary is answered 5xx or fails to connect; raw fuzz deliveries get < 500 |

**Metrics**: issues opened / closed by granary / allowed (expected open and
open) / pending; open→close latency p50/p95/p99/max; webhook deliveries
and failures; persona actions and errors; faults injected; per-second time
series (opened, closed, backlog, p95 latency) for charts, capped at 900
points.

## Consequences
The oracle judges granary against the *policy*, not against its own
bookkeeping, so it would catch a granary that closes allowed users even if
granary's own verdict table agrees with itself.
