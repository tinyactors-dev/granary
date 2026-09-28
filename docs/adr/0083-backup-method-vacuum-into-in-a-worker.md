# 83. Backups use `VACUUM INTO` in a Worker (no online backup API in bun:sqlite)

Date: 2026-09-28 · Status: proposed · Partially superseded by 98

## Context
The preferred tool is SQLite's online backup API (`sqlite3_backup_*`).
bun:sqlite 1.4.1 (SQLite 3.51.0) does **not** bind it (`Database#backup` is
undefined; bun-types has no backup method). It offers `serialize()` and
plain SQL, so `VACUUM INTO` is available.

Spike (scratchpad `ops-spike/`, 400k-row / ~110 MB DB in WAL mode,
`synchronous=FULL`, a separate writer *process* inserting continuously):

| method | result |
|---|---|
| `VACUUM INTO` on a 2nd connection during ~125k concurrent inserts | consistent snapshot, `integrity_check = ok`, output in rollback-journal mode (bytes 18/19 = 1), writer max insert latency 75 ms, ~210–235 ms per 110 MB |
| `VACUUM INTO` on the main thread | 213 ms max event-loop lag |
| `VACUUM INTO` in a Bun `Worker` | **1 ms** max event-loop lag |
| `serialize()` | 30 ms, but the whole DB in memory (RSS 326 MB for 115 MB) and the image keeps the WAL flag (bytes 18/19 = 2): it cannot be opened read-only without patching the header |

Rejected: `bun:ffi` binding of `sqlite3_backup_*` against a system
libsqlite3 (version skew with Bun's embedded SQLite; two SQLite copies
touching the same WAL file is unsafe); file copy of `.sqlite` + `-wal`
(not consistent without blocking writers); `serialize()` (memory, WAL
header gotcha) — kept only as a documented fallback for tiny DBs.

## Decision
- The `snapshot` I/O processor runs a dedicated Bun `Worker` that opens its
  own connection (`busy_timeout=5000`) and runs
  `VACUUM INTO '<spool>/<runId>.<db>.sqlite.partial'`, then renames to
  `.sqlite`, opens it read-only, runs `PRAGMA integrity_check` (must be
  `ok`), `PRAGMA user_version`, `page_count`, and `SELECT count(*)` for every
  table into the manifest.
- Sealing in the same Worker, streaming: zstd (level 9, `Bun.zstdCompress`)
  then AES-256-GCM in 4 MiB chunks with a fresh per-artifact DEK (ADR 0086);
  sha256 of raw, compressed and sealed bytes recorded in the manifest.
- Space precondition: free space on the spool volume ≥ 2.2 × DB size
  (raw + sealed copies), checked with `fs.statfs` before starting; otherwise
  the run fails fast with `disk-insufficient` (and the watchdog is already
  warning, ADR 0088).
- All databases listed in `OpsHost.databases` are backed up — `granary`
  and ops' own `ops.sqlite` (its secrets are ciphertext, so the backup is
  safe to store; restore needs the master key from fnox).
- A `wal_checkpoint(PASSIVE)` is *not* forced; `VACUUM INTO` reads a
  consistent snapshot through the WAL.

## Consequences
Backups are compact (VACUUM rewrites pages) and self-contained single files.
Each run costs one full read of the DB; fine for granary's size profile.
Revisit if bun:sqlite gains a backup binding (incremental page copy).
