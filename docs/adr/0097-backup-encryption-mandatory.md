# 97. Backup encryption is mandatory

Date: 2026-09-28 · Status: proposed

## Decision
- Every artifact is sealed with AES-256-GCM under a fresh per-artifact DEK
  wrapped by the KEK (ADR 0083/0086). There is **no configuration switch**:
  destination/plan schemas have no `encryption` field, `BackupManifest.encryption`
  is a required object whose `alg` is the literal `'AES-256-GCM'`, and the
  restore path and drills **refuse** artifacts without a valid encryption
  block (no plaintext code path exists).
- Without `OPS_MASTER_KEY`, backups do not run at all (ops is `degraded`,
  ADR 0086) — never a silent fallback to plaintext. In dev a generated key is
  used (ADR 0086).
- Also applies to `local-dir` copies on the VM disk.
- KEK rotation (ADR 0086) re-wraps nothing in existing backups; manifests
  record `kekId`, and restore accepts current or previous KEK. A backup whose
  KEK is gone is unrestorable — the UI shows, per destination, how many
  retained backups use a KEK that is no longer configured.

## Consequences
Losing the master key loses the backups; the runbook's first line is
"`OPS_MASTER_KEY` lives in 1Password item `granary`".
