# ops secret store (ADR 0086, 0097, 0158)

The envelope-encryption implementation lives in the platform layer
(`src/lib/platform/secrets/`: `crypto.ts`, `keys.ts`, `store.ts`). `store.ts`
here is the ops adapter over ops.sqlite's `secrets` table: `usedBy`
(destinations/sinks referencing a secret), `ops_audit` entries and
`OpsBackendError`s. It implements `SecretReader` (`../feature.ts`) for I/O
processors. No API returns plaintext. Master key: `GRANARY_MASTER_KEY`
or `<data>/master.key`; rotation via `GRANARY_MASTER_KEY_PREVIOUS`.
