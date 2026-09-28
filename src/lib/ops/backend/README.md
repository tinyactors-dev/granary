# OpsBackend implementation (ADR 0092, 0110)

`backups.ts` implements `OpsBackendBackups` — owner A. `health.ts` implements
`OpsBackendHealth` — owner B. `index.ts` composes both into `OpsBackend` —
owner B. UI work uses `../backend.stub.ts` via `GRANARY_STUB_OPS=1`.
