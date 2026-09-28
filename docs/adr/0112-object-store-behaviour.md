# 112. Object store behaviour: trust nothing, verify everything

Date: 2026-09-28 · Status: accepted · Amends 84, 95, 106

## Context
Found while testing against RustFS and fake-infra (agent C): Bun's multipart
`writer.end()` can **resolve after Bun aborted the upload** (a part failed all
its retries; fake-infra's log shows `DELETE ?uploadId=…` and no object), so a
manifest could be committed for a missing artifact.

## Decision
- After every streamed upload, `HEAD` the key: it must exist with exactly the
  streamed byte count, else `store.error {code:'integrity', retryable:true}`
  and nothing is committed.
- `verifying` re-checks artifact size = `manifest.sealed.bytes` and manifest
  presence. If a committed manifest points at a missing/incomplete artifact,
  the manifest is **withdrawn** (deleted, row's manifest cleared) and the upload
  restarts from a full re-seal/upload; integrity errors always clear the
  actor's manifest before retrying.
- Create-once manifest: presigned PUT + `If-None-Match: *`; 412 → read the
  existing manifest and accept it only if its `sealed.sha256` equals ours,
  else `conflict` (not retryable). 400/501 "NotImplemented" switches the store
  to HEAD-then-PUT. A provider that *silently ignores* the header can't be
  detected at write time; test connection's "PUT If-None-Match (expect 412)"
  step fails for it, which is where the user sees it.
- Error classification (`StoreError.code`): auth (SignatureDoesNotMatch,
  InvalidAccessKeyId, AccessDenied, 401/403) and no-bucket, clock-skew,
  quota, conflict are not retried; server/network/rate-limited/integrity are
  retried with backoff 30 s × 2ⁿ (max 30 min, 6 attempts). Bun's S3 errors
  carry no HTTP headers, so `Retry-After` is honoured only on our own fetches
  (manifest PUT); Bun itself retries each request 3× first.
- Endpoints: the generic `s3` endpoint may carry a path (fake-infra's
  `/s3/eu`); `r2` gets an optional `endpointOverride` (dev/test only; seed
  `OPS_SEED_R2_ENDPOINT_OVERRIDE`), otherwise the endpoint is derived from
  account + jurisdiction (ADR 0106).
- Egress: every byte that left the VM for an off-site store is counted in
  `egress` (`r2-upload` / `s3-upload`), including failed partial uploads,
  manifests and probe objects.

## Consequences
One extra HEAD per upload. A backup counts as `done` only after an
independent read-back of both objects.
