# 103. Ops tests and fake-infra, revised

Date: 2026-09-28 · Status: proposed · Partially supersedes 90 (hooks/heartbeat endpoints, Loki push), 91 (scenarios 4, 10)

## Decision
fake-infra (ADR 0090) changes:
- **Removed**: `/hooks/*`, `/ping/*`, the Loki push API (OTLP only).
- **R2 fidelity**: region `auto` accepted (and `us-east-1`/empty aliases);
  conditional PUT `If-None-Match: *` → 412 when the key exists (also on
  presigned URLs); no versioning/object-lock endpoints (return
  `NotImplemented` like R2); equal-part-size rule enforced on multipart
  complete; `AccessDenied` for requests outside the token's bucket; "1 write
  per second per key" rate limit (429 `SlowDown`) toggleable.
- **exe.dev proxy fake**: an optional front on the OTLP receiver that
  requires `X-Exedev-Authorization: Bearer <token>` (401 + login redirect
  HTML otherwise), strips it, and adds `X-ExeDev-UserID`; and a `peer` mode
  that accepts un-authenticated requests on a separate port standing in for
  `*.int.exe.xyz`.
- **Disk/egress simulation** moves to the app side: test mode may set
  `OPS_TEST_STATFS_OVERRIDE` (free/total bytes) and an egress counter reset.

Scenario changes (ADR 0091):
- #4 becomes **credential rotation without paging**: revoke key →
  `condition/r2-auth` goes `healing` then `attention` after its grace period
  (shortened in tests) → banner endpoint shows it → new key via OpsBackend →
  condition clears; assert **no outbound notification traffic of any kind**
  (fake-infra receives nothing but S3/OTLP).
- #10 (heartbeat) is replaced by **self-healing disk**: statfs override below
  the budget → remediations run in order (events in traces: spool-cleanup,
  drop-local-copy, wal-checkpoint) → backup proceeds when free space returns;
  attention only if still blocked.
- New #13 **retention convergence**: pre-populate 300 synthetic backups of
  varying sizes and ages in fake-infra → one retention pass + re-plans →
  final count/bytes within caps, floor kept, second pass deletes nothing.
- New #14 **egress stretch**: tiny egress budget → `effectiveInterval`
  stretched, recorded as `handled`, no attention.
- New #15 **mandatory encryption**: upload a hand-made plaintext artifact +
  manifest without `encryption` → drill/restore refuse it.
- Real-infra contract suite (opt-in): **R2 itself** (a throwaway bucket +
  Object R&W token via fnox `prod`-like profile `ops-contract`), including
  conditional presigned PUT and multipart; and the exe.dev proxy path to a
  real otel-lgtm VM when `OPS_CONTRACT_EXE_*` is configured. RustFS/otel-lgtm
  in colima remain the default local contract targets.
