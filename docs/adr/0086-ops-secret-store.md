# 86. Secret store: envelope encryption in ops.sqlite, master key from fnox

Date: 2026-09-28 · Status: proposed

## Context
Sink and destination credentials are entered in the UI, so they must be
stored by the product — but a DB file (and its backups!) must never contain
usable secrets, and the browser must never see a secret again after saving.

## Decision
- **Key hierarchy**: a 256-bit **KEK** from `OPS_MASTER_KEY` (base64), stored
  in fnox's `prod` profile (1Password item `granary`, field
  `ops-master-key`). Each secret gets its own random 256-bit **DEK**; the
  value is encrypted with AES-256-GCM (WebCrypto `crypto.subtle`) under the
  DEK, and the DEK is wrapped (AES-KW or AES-GCM) under the KEK.
  `kek_id` = first 8 bytes of sha256(KEK), hex.
- **Table** `secrets(id, name, kind, ciphertext, iv, wrapped_dek, kek_id,
  fingerprint, created_at, updated_at, last_used_at, last_used_ok)`. AAD =
  `secret:<id>:<name>` so ciphertexts can't be swapped between rows.
  `fingerprint` = last 4 chars of the value plus an HMAC-SHA256 prefix under
  the KEK (identifies "same secret" without revealing it).
- **Rotation**: `OPS_MASTER_KEY_PREVIOUS` may be set; secrets whose `kek_id`
  matches the previous key are decrypted with it and rewrapped under the
  current key at boot (only DEKs are rewrapped; values untouched). The ops
  page shows how many secrets are still on an old KEK. Credential rotation
  for a destination = save a new value → "test connection" with it → the
  old value is kept as `previous` for 24 h so in-flight uploads can finish.
- **Backups** reuse the hierarchy: each backup artifact has its own DEK,
  wrapped under the KEK and stored in the manifest → restoring needs only the
  master key + object-store credentials (both outside the backup).
- **Access rules**:
  - write-only API: `OpsBackend.setSecret(ref, value)` returns metadata
    only; no method returns plaintext;
  - actors hold `secretRef` ids, never values; only I/O processors call
    `secrets.reveal(ref)` at the moment of the request;
  - "test connection" runs server-side, and may use an unsaved candidate
    value that is discarded afterwards;
  - `ops_audit` records who set/rotated/used (by processor type) which ref.
- **Dev**: without `OPS_MASTER_KEY` in dev mode, a key is generated once into
  `data/ops-master.key` (0600, gitignored) and a banner says so. In
  production a missing key puts ops into `degraded` (config readable, nothing
  that needs a secret runs) and `status().sleepOk = false`.
- **Redaction** (ADR 0093): the processor that revealed a secret registers
  its value with the redactor for the duration of the request; outgoing
  telemetry and logs replace exact matches with `‹redacted:<ref>›`.

## Consequences
Losing `OPS_MASTER_KEY` means losing all stored credentials and the ability
to decrypt backups — the runbook makes "master key is in 1Password" item #1.
