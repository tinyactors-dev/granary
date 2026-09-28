# ops I/O processors — the only code with side effects (ADR 0082, 0101)

Types: `OPS_IO` in `../schemas/events.ts`. Secrets are revealed here and nowhere else (`SecretReader`, `../feature.ts`).

| File | Type | Owner |
|---|---|---|
| `snapshot.ts` + `snapshot.worker.ts` | `snapshot` (VACUUM INTO in a Bun Worker) | A (backups, M1) |
| `object-store.ts` | `object-store` (Bun.S3Client: r2/s3; local-dir) | A (M2) |
| `otlp.ts` | `otlp` (OTLP/HTTP, exe-peer / exe-vm-token auth) | B (telemetry, M4) |
| `remediate.ts` | `remediate` (spool cleanup, statfs, WAL checkpoint) | B (M3) |
