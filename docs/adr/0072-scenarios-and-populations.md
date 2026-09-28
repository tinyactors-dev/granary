# 72. Scenarios are seeded populations with an arrival process

Date: 2026-09-28 · Status: accepted

## Decision
A scenario (`ScenarioConfig`, TypeBox in `loadgen/schemas.ts`) is:

- `name`, `seed` (uint32),
- `mix`: weight per persona kind (0 disables a kind),
- `personas`: how many personas arrive in total,
- `arrivalRatePerMin`: steady-state arrival rate, reached after `rampUpMs`
  (rate ramps linearly from 10 % to 100 %),
- `durationMs`: arrivals stop after this (whichever of count/duration comes
  first),
- `timeScale`: multiplier on persona think-times (1 = human-ish seconds,
  0.1 = ten times faster),
- `closeDeadlineMs` / `faultGraceMs`: eventual-closure budget (ADR 73).

The **arrival plan** (at-offset + kind + persona seed per arrival) is
computed up front from the seed (exponential gaps under the ramped rate,
weighted kind choice), so a seed fully determines who arrives when. Presets:
`smoke`, `steady`, `slop-storm`, `bot-flood`, `chaos`, `fuzz`.

The coordinator actor `scenario/<id>` (`loadgen/actors/scenario.ts`):
`created → running ⇄ paused → draining → settling → finished`, `stop` from
any non-final state → `stopped`.
- `running`: a delayed `arrival` send (id `arrival`) spawns the next persona
  via the `host` I/O processor; a delayed `duration.elapsed` (id `duration`)
  ends arrivals.
- `paused`: both timers are cancelled and the remaining time kept; the
  engine also **holds every persona action** (queued in the `github`
  processor) until resume. Persona think-timers keep running, so resuming
  releases a burst — documented, acceptable for a dev tool.
- `draining`: no new arrivals; waits for all personas to reach a final
  state (engine posts `personas.done`) or a drain timeout.
- `settling`: waits until every issue expected to be closed is closed or
  its deadline passed (engine posts `observer.settled`), then `finished`.

Only one scenario runs at a time (409 otherwise); finished scenarios stay
in memory for inspection until deleted or `POST /api/reset`.
