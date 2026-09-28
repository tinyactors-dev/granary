# 81. Ops runs in the app process, in its own tinyactors System

Date: 2026-09-28 · Status: proposed · Partially superseded by 100 (external heartbeat)

## Context
Ops needs the SQLite file (same host), granary's telemetry batches and health
numbers (in-memory), and serves admin UI pages. It must not disturb issue
handling: a slow upload or a VACUUM must not stall granary's pump, and a
faulting ops actor must not show up in granary's traces or dead letters.

## Decision
- **Same OS process** as the app (started from `bootBackend`), because the
  host ports (health, telemetry tap) are in-memory and the UI is served
  there. A separate process (like `loadgen/`) was rejected: it would need an
  IPC protocol for health + telemetry and duplicate the admin UI plumbing.
- **Separate `System`** (`createSystem({ io: opsIO, done, fault, deadLetter })`)
  with its own trace sink (`service.name = granary-ops`), scheduling budget
  and dead-letter accounting. Two Systems in one process share nothing but the
  JS thread.
- **Heavy work off the JS thread**: SQLite snapshots run in a Bun `Worker`
  (spike: `VACUUM INTO` of 110 MB on the main thread caused 213 ms of event
  loop lag; in a Worker, 1 ms). Compression/encryption stream in the same
  Worker. Uploads are async I/O (`Bun.S3Client`) and don't block.
- A crash of the process takes ops down with the app — which is exactly why
  the external dead-man's switch exists (ADR 0088).

## Consequences
One deployable; ops cannot alert about the whole process dying — the
heartbeat to an external service covers that.
