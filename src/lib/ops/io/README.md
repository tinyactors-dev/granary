# ops I/O processors — the only code with side effects (ADR 0082, 0101)

Types: `OPS_IO` in `../schemas/events.ts`. Secrets are revealed here and nowhere else (`SecretReader`, `../feature.ts`).

| File | Type | Owner |
|---|---|---|
| `snapshot.ts` + `snapshot.worker.ts` | `snapshot` (VACUUM INTO in a Bun Worker) | A (backups, M1) |
| `object-store.ts` | `object-store` (Bun.S3Client: r2/s3; local-dir): seal+upload, create-once manifest, verify, retention passes, drill fetch | A (M2) |
| `backup-ledger.ts` | `backup-ledger`: the backups feature's row writes + reconcile (ADR 0111) | A |
| `otlp.ts` | `otlp` (OTLP/HTTP, exe-peer / exe-vm-token auth; test connection) | B (telemetry, M4) |
| `remediate.ts` | `remediate` (built-in remediations + those contributed by features) | B (M3) |
| `sample.ts` | `sample` (one watchdog measurement pass → `signal.sample`) | B (M3) |
| `journal.ts` | `journal` (condition rows + ops events) | B (M3) |
