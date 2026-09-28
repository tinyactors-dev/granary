# 95. Cloudflare R2 is the backup destination (S3-generic underneath)

Date: 2026-09-28 · Status: proposed · Partially superseded by 106 (endpoint derivation) · Partially supersedes 84 (destination kinds, test connection, bucket prerequisites)

## Context
The user picked **Cloudflare R2**. Facts from Cloudflare's docs (retrieved
2026-09-28):
- S3 API compatibility, <https://developers.cloudflare.com/r2/api/s3/api/>:
  endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; region is `auto`
  ("an empty value and `us-east-1` will alias to the `auto` region");
  PutObject ✅ incl. conditional `If-Match`/`If-None-Match`; ListObjectsV2,
  HeadObject, DeleteObject(s) ✅; all multipart operations ✅ (Create,
  UploadPart, Complete, Abort, ListMultipartUploads); **Object Lock ❌,
  versioning ❌**; checksums: only CRC64NVME full-object, others composite
  only; lifecycle Get/PutBucketLifecycleConfiguration ✅; storage classes
  STANDARD and STANDARD_IA.
- Limits, <https://developers.cloudflare.com/r2/platform/limits/>: object
  ≤ 5 TiB, single PUT ≤ 5 GiB, multipart ≤ 10,000 parts, key ≤ 1,024 bytes,
  metadata ≤ 8,192 bytes, "concurrent writes per object: 1 per second".
  (Part-size rules are not on that page; the S3-compat page says re-uploading
  a part number replaces it. We assume the usual "all parts but the last
  equal, ≥ 5 MiB" and verify in the contract suite.)
- Lifecycle, <https://developers.cloudflare.com/r2/buckets/object-lifecycles/>:
  "Buckets have a default lifecycle rule to expire multipart uploads seven
  days after initiation"; expiration and transitions typically apply within
  24 h.
- Tokens, <https://developers.cloudflare.com/r2/api/tokens/>: **Object Read &
  Write** "allows the ability to read, write, and list objects in specific
  buckets" and cannot manage buckets; S3 credentials are derived as Access
  Key ID = token `id`, Secret Access Key = SHA-256 of the token `value`.

## Decision
- Destination kind **`r2`** is a preset over the generic `s3` kind: the form
  asks for *Account ID*, *bucket*, *prefix*, *Access Key ID*, *Secret Access
  Key*; ops derives `endpoint = https://<account>.r2.cloudflarestorage.com`,
  `region = auto`, path-style (`virtualHostedStyle: false`),
  `storageClass = STANDARD` (fixed; ADR 0096). The `s3` kind stays for
  anything else (and for fake-infra/RustFS in tests).
- **Bun.S3Client needs nothing R2-specific** beyond endpoint + region `auto`
  (Bun's own docs use an R2 endpoint as an example); `partSize` 8 MiB,
  `queueSize` 4, `retry` 3 — fixed-size parts satisfy R2's equal-part rule.
- **Token guidance** shown in the UI: create an R2 API token with **Object
  Read & Write**, scoped to **this bucket only**; no Admin permissions (ops
  never creates or configures buckets). Delete is needed for retention and is
  exercised by the probe.
- **Commit marker is create-once**: the manifest is PUT via a presigned URL
  (`S3Client.presign(key, {method:'PUT'})`) with `fetch` and
  `If-None-Match: *`, because Bun's client can't set conditional headers. A
  412 means the run was already committed (idempotent success after a
  crash); a second writer can never overwrite a committed manifest. Contract
  test must confirm R2 honours the unsigned `If-None-Match` header on a
  presigned PUT; if not, fall back to HEAD-then-PUT (the actor is the single
  writer per key anyway).
- **Test connection** (step list in the UI, each step pass/fail with the
  S3 error code): PUT probe object → HEAD (size) → ListObjectsV2 on the
  prefix → GET + compare → conditional PUT with `If-None-Match: *` on the
  same key (expect 412) → DELETE → HEAD (expect 404). Plus advisory checks
  that can't be automated with an object-scoped token, shown as a checklist:
  the default 7-day abort-multipart rule is still present (R2 dashboard →
  bucket → Settings → Object lifecycle rules), no lifecycle rule deletes
  under our prefix (retention is ours, ADR 0096), no public bucket access.
- **No versioning/object lock on R2** → protection against deletion comes
  from token scope (only this bucket) and from keeping the token only in the
  secret store; documented as an accepted risk.
- Checksums: our own sha256 in the manifest (ADR 0084); we don't rely on
  `x-amz-checksum-*` given R2's partial support.

## Consequences
One R2 bucket per environment; the token is the blast radius. Moving to
another S3-compatible store is a destination-kind change, not a code change.
