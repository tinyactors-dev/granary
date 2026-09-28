# 80. Operations is a separate domain module with a pinned contract

Date: 2026-09-28 · Status: proposed

## Context
granary needs backups, off-site storage, telemetry export and alerting —
"the purpose of this system is to let me sleep at night". This is a different
domain from issue gatekeeping and must not leak into it (or vice versa).

## Decision
- All operations code lives in **`src/lib/ops/`** (inside `src/lib` so SvelteKit
  remote functions and `hooks.server.ts` can import it without Vite `fs.allow`
  tricks; the `fake-github/schemas.ts` precedent shows cross-root imports work
  but are awkward). Layout:
  ```
  src/lib/ops/
    contract.ts        # THE seam: TypeBox schemas + TS interfaces (only file granary imports)
    index.ts           # createOps(host: OpsHost): OpsModule  (only file boot.ts imports)
    schemas/           # config, run, alert, secret DTOs (TypeBox)
    actors/            # one file per actor (ADR 0082)
    io/                # I/O processors: snapshot, object-store, otlp, loki, notify, heartbeat
    secrets/           # secret store (ADR 0086)
    db.ts              # ops.sqlite (ADR 0089)
    backend.ts         # OpsBackend implementation for remote functions (ADR 0092)
    backend.stub.ts
  src/lib/remote/ops.remote.ts   # remote functions, delegate to OpsBackend
  src/routes/ops/**              # admin UI pages
  fake-infra/                    # fakes (ADR 0090)
  ```
- **Dependency rule** (enforced by `mise run check:boundaries`, an ast-grep
  scan): granary code may import only `$lib/ops/contract` and `$lib/ops/index`
  (the latter only from `src/lib/server/boot.ts`). Ops code must not import
  `$lib/server/**`, `$lib/schemas/**` (other than `standard.ts`) or remote
  modules; it talks to granary only through `OpsHost` ports.
- **Contract** (`contract.ts`), sketched:
  ```ts
  /** What granary gives ops. Everything is a port; ops never reaches in. */
  interface OpsHost {
    databases: { id: string; path: string; label: string }[];   // 'granary'
    health(): HostHealthSnapshot;        // TypeBox: outbox pending/dead/oldestAgeMs, inbox pending/oldestAgeMs,
                                         // deadLetters (counter), quarantined actors, relay lastSuccessAt,
                                         // lastWebhookAt, eventLoopLagP99Ms, rssBytes
    telemetry: TelemetrySource;          // subscribe(cb) → granary's OTLP batches {signal:'traces'|'logs', bytes, contentType}
    log: { info; warn; error };          // granary's logger (ops never console.logs directly)
    env: Record<string, string | undefined>; // for OPS_* seeds + master key only
    dataDir: string;                     // where ops.sqlite / spool live
  }
  /** What ops gives granary. */
  interface OpsModule {
    start(): Promise<void>; stop(): Promise<void>;
    status(): OpsStatus;                 // TypeBox: sleepOk: boolean, reasons[], per-area summaries
    telemetrySink: TelemetrySink;        // granary's Tracer writes batches here (fan-out owned by ops)
    backend: OpsBackend;                 // for src/lib/remote/ops.remote.ts (ADR 0092)
  }
  interface TelemetrySource { subscribe(cb: (b: TelemetryBatch) => void): () => void }
  interface TelemetrySink { write(b: TelemetryBatch): void } // never throws, never blocks
  ```
- granary changes are limited to: `boot.ts` creates ops after the WAL/system
  are up, passes an `OpsHost`, and wires the Tracer's export through
  `ops.telemetrySink` (see ADR 0085); `backend.real.ts` gains nothing — the ops
  UI uses its own `OpsBackend` seam.

## Consequences
Ops can be tested, stubbed and replaced without touching granary internals.
Adding a signal to the watchdog means extending `HostHealthSnapshot` in the
contract first.
