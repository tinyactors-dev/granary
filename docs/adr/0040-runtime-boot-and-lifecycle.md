# 40. Runtime boot, issue actor states and process lifecycle

Date: 2026-09-28 · Status: accepted

## Context
ADR 0002/0003/0033 fix the topology, the WAL and the protocol. This records
how the actor-system implementation wires them together, the details those
ADRs left open, and what the test harness can rely on.

## Decision
### Files (`src/lib/server/`)
| File | Role |
|---|---|
| `wal.ts` | `Wal`: bun:sqlite, pragmas + tables of ADR 0003 (+ indexes), migrations tracked by `PRAGMA user_version`, typed accessors validating rows with `$lib/schemas/wal` |
| `actors/issue.ts`, `actors/allowlist.ts` | the two charts (one file per actor) |
| `io/github.ts` | the durable `github` I/O processor |
| `relay.ts`, `github-client.ts` | the outbox relay and its REST client (ADR 0041) |
| `system.ts` | `startRuntime()`: the `globalThis` singleton (`Symbol.for('granary.runtime')`) holding WAL, System, relay, tracer, sweeper |
| `tracing.ts`, `otlp-encode.ts` | trace sink, span enrichment, OTLP re-encoding (ADR 0042) |
| `inbound.ts` | webhook signature check, payload → `issue.opened` data |
| `dap.ts` | DAP TCP server (dev only, `globalThis` singleton) |
| `backend.real.ts` | `RealBackend implements Backend` |
| `boot.ts` | `bootBackend(config, {devMode})`: runtime + DAP + shutdown hooks |
| `config.ts`, `oauth.ts`, `log.ts` | route helpers |

### Boot (`hooks.server.ts` `init` → `bootBackend`)
svelte-adapter-bun awaits `init` before `Bun.serve`, so HTTP is accepted only
after: open DB (migrate, seed `ALLOWED_USERS_SEED`) → `createSystem({io:
{github}, done, fault, deadLetter})` → trace sink → define charts → spawn
`allowlist/main` (binding: lower-cased `allowed_users`) → `setLoader('issue')`
→ relay start (`inflight` rows → `pending`, first pass) → re-post every
`pending` inbox row → DAP server (dev) → `setBackend`. A sweeper (every 30 s,
unref'd) re-posts `pending` inbox rows older than 30 s and deletes expired
sessions. Under Vite HMR, `init` sees `hasBackend()` and the runtime singleton
and does nothing.

### Configuration additions (`$lib/schemas/config`, additive)
- `ALLOWED_USERS_SEED` — comma-separated logins inserted into `allowed_users`
  with `added_by='seed'` at boot if absent (tests / local dev).
- `RELAY_BASE_DELAY_MS` — first outbox retry delay (default 1000), see ADR 0041.

### Issue chart details
- Data defaults come from `.data(...)`; the loader binding (full
  `IssueActorData`) overrides them.
- `restore` routes: `phase = closing` (with an issue) → `closing`; otherwise →
  `idle`. A `settled` actor waits in `idle` for the mail that loaded it:
  `issue.opened` (or a late `github.closed`/`github.gave-up`) → `settled`, so
  the triggering inbox row's `deliveryId` reaches the done hook and is marked
  `done` (otherwise it would stay `pending` and be swept forever).
- `closing` entry sets `phase = 'closing'` and sends `github.close` via the
  `github` processor; `issue.opened` has no transition there (ignored), also
  in `checking`. `error.communication` in `closing` (the processor threw, no
  outbox row) → `failed` with reason `github-gave-up: outbox write failed: …`.
- `checking` entry: `allowlist.check` to `#_actor_allowlist/main` + delayed
  `check.timeout` (id `check-timeout`, 10 s); exit cancels `check-timeout`.
- Final states carry `IssueDoneData` via `<donedata>`.

### Hooks
- `done`: issue family → `parseIssueDoneData` → one transaction: verdict
  (`INSERT OR REPLACE`, never for `settled`) + inbox row `done`.
- `fault`: inbox row of `data.deliveryId` → `failed`; the quarantined actor is
  destroyed on the next microtask so its address can load again.
- `deadLetter`: logged.

### Shutdown
`SIGTERM`/`SIGINT` and svelte-adapter-bun's `sveltekit:shutdown`: stop
sweeper, stop relay (5 s grace, then abort; aborted effects stay `inflight`
and are reset at next boot), stop DAP, `system.close()`, `db.close()`. A 2 s
unref'd fallback `process.exit(0)` covers hosts where something else keeps the
loop alive (Vite).

## Consequences
- The whole decision state lives in SQLite; a SIGKILL at any point is
  recovered by the boot re-post + loader + relay reset (verified: kill after
  202, kill between comment and PATCH).
- `POST /webhook` must be sent with a non-form content type
  (`application/json`, as GitHub and the fake do): SvelteKit's CSRF check
  rejects cross-site `application/x-www-form-urlencoded` POSTs with 403, so
  GitHub's "form" webhook content type is unsupported.
