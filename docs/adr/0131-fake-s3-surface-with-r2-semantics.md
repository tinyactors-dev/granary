# 131. The fake S3 surface and its R2 semantics

Date: 2026-09-28 · Status: accepted

## Decision
- **Routing**: path-style under `/s3/<bucket>/<key>` — exactly what Bun's
  S3 client sends for `endpoint: http://host:4090/s3` (it keeps the endpoint
  path prefix and signs the full path). The **jurisdiction** a request
  arrives through is the Host header (`<account>.eu.r2.cloudflarestorage.com`)
  or a leading segment: `endpoint: …/s3/eu` → EU. As on R2, a bucket is only
  found through its own jurisdiction's endpoint (else `NoSuchBucket`).
  Bucket names are ≥ 3 chars, so `eu`/`fedramp` never collide.
- **Auth**: SigV4 header auth and presigned URLs (`fake-infra/s3/sigv4.ts`),
  verified against the issued secret; `x-amz-content-sha256` checked when it
  is a real hash. Errors: `InvalidAccessKeyId` (unknown/revoked),
  `SignatureDoesNotMatch`, `RequestTimeTooSkewed` (> 15 min off the fake's
  clock incl. skew), `AccessDenied` (anonymous, expired presign, bucket
  outside the key's scope, bucket management).
- **Operations**: PUT/GET/HEAD/DELETE object, `Range` (206/416),
  `If-Match`/`If-None-Match` on reads, ListObjectsV2 (prefix, delimiter,
  max-keys ≤ 1000, continuation token = base64url of the last key,
  start-after, `encoding-type=url`), multipart create/part/complete/abort and
  `?uploads` listing, `POST ?delete` (DeleteObjects), admin-only ListBuckets.
  ETags: MD5 hex; multipart `md5(concat(part md5s))-N`. CopyObject /
  UploadPartCopy → 501.
- **Write rules**: `If-None-Match: *` → 412 `PreconditionFailed` when the key
  exists (also on CompleteMultipartUpload); `If-Match` on writes; parts
  smaller than 5 MiB (except the last) → `EntityTooSmall`.
- **Quota** (`quotaBytes` per bucket): a write that would exceed it fails with
  HTTP 507 and code `QuotaExceeded` (R2 has no such code; this is the
  "disk/quota full" stand-in the ADR 90 promised).
- Errors are S3 XML (`<Error><Code>…`), which is what Bun surfaces as
  `S3Error.code`.
