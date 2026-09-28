# 32. The `Backend` interface is the seam between UI and actor system

Date: 2026-09-28 · Status: accepted

## Context
Remote functions (UI agent) and the actor system / WAL / relay (actor-system
agent) are built in parallel. Remote functions must not import actors,
SQLite or tinyactors directly.

## Decision
- `src/lib/server/backend.ts` defines `interface Backend` — one async method
  per operation remote functions, hooks and the OAuth routes need (sessions,
  dashboard read models, allowlist, effects, actors, dev). Inputs are
  validated DTOs from `$lib/schemas/api` / `$lib/schemas/dev`, with `limit`
  defaults already resolved (`Resolved<T>`).
- Expected failures throw `BackendError(code, message)` with
  `code ∈ not-found | conflict | invalid | unavailable | upstream`;
  `backendErrorStatus` maps them to 404/409/400/503/502. Other errors are 500s.
- Registry: `setBackend(b)` stores the instance on `globalThis` under
  `Symbol.for('granary.backend')` (survives Vite HMR, like the System
  singleton of ADR 0002); `getBackend()` returns it or throws a clear error;
  `hasBackend()` for hooks that must not throw.
- The actor-system agent implements `Backend` and calls `setBackend(...)`
  from `hooks.server.ts` `init`, after the boot order of ADR 0003.
- `src/lib/server/backend.stub.ts` exports `StubBackend implements Backend`:
  in-memory, seeded, mutable, touches nothing external. It is **not
  registered by default**. `hooks.server.ts` registers it instead of the real
  backend when `GRANARY_STUB_BACKEND=1` (`loadConfig(env, {requireSecrets:
  false}).stubBackend`), without booting the actor system:
  `setBackend(new StubBackend({ admins: config.admins, dapPort: config.dapPort }))`.
  UI work: `GRANARY_STUB_BACKEND=1 ADMINS=admin bun --bun vite dev`, then log
  in through `/__dev` (`devLoginAs`).

## Consequences
Remote functions stay thin and testable against the stub. Any new UI need is
a new `Backend` method (plus DTO), added here first.
