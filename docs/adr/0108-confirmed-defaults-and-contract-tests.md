# 108. Confirmed defaults and agreed contract tests

Date: 2026-09-28 · Status: accepted

## Decision
The user confirmed:
- Retention caps per destination: **8 GiB** and **82 backups per database**
  (ADR 0096).
- **20 GiB/month** R2 upload egress, **5 GiB/month** telemetry volume
  (ADR 0107).
- Contract tests (ADR 0103) against the real services are part of the plan:
  1. exe.dev proxy: large (≥ 4 MiB) OTLP protobuf POSTs to a private port
     (:4318) via both `exe-peer` and `exe-vm-token` succeed; 401 without
     credentials.
  2. R2 (EU jurisdiction bucket): presigned PUT with unsigned
     `If-None-Match: *` → 200 on a new key, 412 on an existing key; multipart
     upload with 8 MiB parts; the Object R&W token cannot list buckets.
  Results are recorded in a follow-up ADR; fallbacks (VM token; HEAD-then-PUT)
  stay specified in ADRs 0099/0095.
