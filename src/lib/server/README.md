# src/lib/server

Server-only code (SvelteKit refuses to import `$lib/server/*` into client code).

Contract (shared with the UI agent, ADR 0031/0032/0034):
- `backend.ts` — `interface Backend`, `BackendError`, `setBackend`/`getBackend`
- `backend.stub.ts` — `StubBackend`, in-memory fake for UI work (`GRANARY_STUB_BACKEND=1`)
- `auth.ts` — `requireUser`/`requireAdmin`/`requireDev`, session cookie helpers
- `remote-helpers.ts` — `withBackend()` (BackendError → HTTP error)

Actor system (ADR 0040–0042):
- `boot.ts` — `bootBackend(config, {devMode})`, called from `hooks.server.ts` `init`
- `system.ts` — `startRuntime()` / `getRuntime()`: the `globalThis` runtime (WAL, System, relay, tracer, sweeper), boot order of ADR 0003, done/fault/deadLetter hooks, issue loader
- `wal.ts` — SQLite write-ahead log (`bun:sqlite`: inbox / outbox / verdicts / allowed_users / sessions)
- `actors/` — one file per actor statechart (`issue.ts`, `allowlist.ts`)
- `io/github.ts` — durable `github` I/O processor (outbox writer + relay kick)
- `relay.ts`, `github-client.ts` — outbox relay and GitHub REST client (ADR 0041)
- `tracing.ts`, `otlp-encode.ts` — trace sink, span enrichment, OTLP export, dev span buffer (ADR 0042)
- `inbound.ts` — webhook signature verification and payload → `issue.opened`
- `dap.ts` — DAP TCP server (dev only)
- `backend.real.ts` — `RealBackend implements Backend`
- `config.ts`, `oauth.ts`, `log.ts` — helpers for routes
