# ops secret store (ADR 0086, 0097) — owner: A (backups, M2)

Envelope encryption in ops.sqlite (`secrets` table), KEK from `OPS_MASTER_KEY`
(fnox `prod` profile), rotation via `OPS_MASTER_KEY_PREVIOUS`. Implements
`SecretReader` (`../feature.ts`) for I/O processors. No API returns plaintext.
