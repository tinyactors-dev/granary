# 141. Write-only secrets in /ops forms

Date: 2026-09-28 · Status: accepted · Implements 86

## Decision
- Destination and sink forms offer a **secret picker**: choose a stored
  secret (listed by name + fingerprint) or type a new value into a password
  input. Stored values are never displayed or returned.
- A typed-but-unsaved secret is represented in the draft by the placeholder
  ref `new-secret` (`NEW_SECRET_REF`). The value travels separately:
  - **test connection** sends it as `candidateSecrets["new-secret"]`, used for
    that test only (ADR 0086);
  - **save** sends it as `secret: {name, kind, value}`; `ops.remote.ts` calls
    `setSecret` first and substitutes the new ref into the draft before
    `saveDestination`/`saveSink`.
  The placeholder never reaches the backend on save.
- `/ops/secrets` uses a remote `form` (`setOpsSecret`, one instance per
  secret via `.for(id)` for "replace"); after submit the input is reset and
  the result is metadata only (fingerprint). Master-key status and rotation
  steps (fnox `prod` profile, `OPS_MASTER_KEY_PREVIOUS`) are shown there.
- The constant is defined twice (UI module and remote file) because the
  boundary rule's `/ops/` pattern also matches `$lib/components/ops/…`.

## Consequences
Verified in a browser: after saving a destination/sink/secret, the page HTML
never contains the typed value.
