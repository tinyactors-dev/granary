# ops secret store (ADR 0086, 0097) — owner: A (backups, M2)

Envelope encryption in ops.sqlite (`secrets` table), KEK from `OPS_MASTER_KEY`
(fnox `prod` profile), rotation via `OPS_MASTER_KEY_PREVIOUS`. Implements
`SecretReader` (`../feature.ts`) for I/O processors. No API returns plaintext.

`crypto.ts` (AES-GCM, key wrap, chunk nonces/AAD), `keys.ts` (KEK loading, dev key file, rotation), `store.ts` (SecretStore: set/list/delete/reveal, candidates overlay, boot re-wrap). Details: ADR 0117.
