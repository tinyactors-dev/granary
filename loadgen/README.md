# loadgen — personas that drive granary through the fake GitHub

A third process (ADR 0070) with its own tinyactors system. Scenarios
(ADR 0072) spawn **personas** — statecharts, one file per kind in
`personas/` (ADR 0071) — that open, reopen and comment on issues, inject
faults and fuzz webhooks on the fake GitHub. Granary only ever sees the
resulting webhooks. An observer (ADR 0073) follows the fake's event stream
and checks invariants against the policy oracle.

```
mise run up                                   # fake GitHub + app + loadgen daemons
open http://localhost:5173/admin/load         # portal: scenarios, personas, invariants
mise run load:run -- --preset chaos --seed 7  # headless; exit 1 on violations
```

| File | Role |
|---|---|
| `server.ts` | HTTP API on `LOADGEN_PORT` (4040) |
| `cli.ts` | headless run of one scenario |
| `engine.ts` | system, `github`/`host` I/O processors, routing, scenarios |
| `actors/scenario.ts` | scenario coordinator statechart |
| `personas/*.ts` | one statechart per persona kind (+ `common.ts`, `trusted.ts`, `index.ts`) |
| `observer.ts` | issue ledger, metrics, invariants |
| `plan.ts` | presets, config resolution, seeded arrival plan |
| `fuzz-cases.ts`, `text.ts`, `rng.ts` | fuzz cases, persona prose, seeded randomness |
| `schemas.ts` | TypeBox API schemas (shared with the app's dev backend) |

Env (ADR 0230): `LOADGEN_PORT`, `FAKE_GITHUB_URL`, `LOADGEN_ALLOWLISTED`
(must match granary's `GRANARY_SEED_ALLOWLIST`), `LOADGEN_GRANARY_LOGIN`
(the GitHub App's bot login, `granary[bot]` for the app the dev bootstrap
creates), `LOADGEN_OTLP_ENDPOINT`.
