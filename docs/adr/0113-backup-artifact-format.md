# 113. Backup artifact format and the snapshot Worker

Date: 2026-09-28 · Status: accepted · Amends 83, 97, 98

## Decision
- **Snapshot**: a Bun Worker started from a Blob URL (`io/snapshot.worker.ts`
  exports its JavaScript source) so it survives Vite/adapter-bun bundling
  without a separate worker entry file. It opens its own read-write
  connection (`busy_timeout=5000`), runs `VACUUM INTO '<spool>/<run>.<db>.sqlite.partial'`,
  renames, reopens read-only, requires `integrity_check = ok`, and returns
  sqlite version, user_version, page_count, per-table row counts, size and
  sha256. The same Worker runs drill/restore checks.
- **Sealing** (streaming, never written to disk, ADR 0098): the raw file is
  read in 4 MiB blocks, each compressed as an independent zstd frame
  (level 9, `Bun.zstdCompress`; concatenated frames form one valid zstd
  stream), then encrypted with AES-256-GCM in 4 MiB plaintext chunks under a
  fresh per-artifact DEK. Chunk *i*: nonce = `nonceBase XOR i` (big-endian in
  the last 8 bytes), AAD = `granary-ops-backup/1|<runId>|<i>|<last>`. A final
  chunk (possibly empty, `last=1`) is always written, so truncation,
  reordering and cross-run splicing fail authentication. The DEK is wrapped
  with AES-GCM under the KEK, AAD `backup-dek:<runId>`.
- The manifest records raw/compressed/sealed sizes + sha256, chunk size,
  `kekId`, wrapped DEK and nonce base. Unsealing verifies all three hashes and
  sizes; the raw sha256 is re-checked while sealing (the snapshot may not
  change between snapshot and upload).
- Restores and drills refuse any manifest without a valid encryption block
  (`not-encrypted`); unknown KEKs fail with `decrypt-failed`.

## Consequences
A backup is restorable with the master key (current or previous) plus read
access to the bucket — nothing on the VM is needed (ADR 0116).
