# 117. Secret store implementation details

Date: 2026-09-28 · Status: accepted · Amends 86

## Decision
- KEK from `OPS_MASTER_KEY` (base64 or hex, 32 bytes); `kekId` = first 8
  bytes of sha256(KEK). Dev mode without a key generates
  `<dataDir>/ops-master.key` (0600). Missing in production → `master:'missing'`,
  secrets can't be stored or revealed and plans refuse to dispatch (recorded
  as `info` items), never plaintext backups.
- Value AAD = `secret:<id>:<name>`, DEK AAD = `secret-dek:<id>`: a secret's id
  and name are bound to its ciphertext, so ids are never renamed (seeds create
  secrets under fixed ids `seed-r2-secret`, `seed-s3-secret`).
- Fingerprint = `…<last 4> · <6 hex of HMAC-SHA256(KEK, value)>`.
- Replacing a value keeps the previous ciphertext for 24 h (columns
  `previous_*`); expired previous values are dropped at boot. Boot also
  re-wraps DEKs still under `OPS_MASTER_KEY_PREVIOUS` (values untouched) and
  records a `handled` item.
- `reveal()` registers the value with the redactor for 10 min and writes an
  `ops_audit` row (`secret.reveal`, actor = processor/purpose). Test
  connection uses `withCandidates()` — an in-memory overlay for unsaved values
  that is discarded afterwards and never recorded as the destination's test.
- `usedBy` is derived by scanning destination and sink configs for
  `secretRef`; deleting a referenced secret is a `conflict`.
