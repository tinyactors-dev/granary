# 84. Object storage destinations via Bun.S3Client, committed by manifest

Date: 2026-09-28 · Status: proposed · Partially superseded by 95, 96

## Decision
- **Client**: Bun's built-in `S3Client` (prefer-Bun rule). Spike against
  RustFS (S3-compatible; public MinIO images are no longer pullable):
  87 MB multipart upload (11 parts, `partSize` 8 MiB, `queueSize` 4) in
  276 ms, `stat`/`list`/`delete`/download all work, sha256 round-trips, bad
  credentials surface as `S3Error` with `code = "SignatureDoesNotMatch"`.
  Limitations found: no CreateBucket, no custom object metadata
  (`x-amz-meta-*`), no multipart listing/abort. Consequences below.
- **Destination kinds**: `s3` (AWS S3, Cloudflare R2, Backblaze B2,
  DigitalOcean Spaces, Hetzner, Garage/RustFS/MinIO — all via
  `endpoint`, `region`, `bucket`, `prefix`, `virtualHostedStyle`,
  `storageClass`) first; the `object-store` processor dispatches on `kind`
  so `local-dir` (for dev/tests and a second on-box copy) and later `gcs`
  (XML API, HMAC keys) or `azure-blob` can be added.
- **Layout**: `<prefix>/<database>/<yyyy>/<mm>/<dd>/<runId>.sqlite.zst.aesgcm`
  plus `<same>.manifest.json`. **The manifest is the commit marker**: a backup
  exists iff its manifest exists (written after the data object and after
  `stat` confirmed its size). Manifest (TypeBox `BackupManifest`): runId,
  database, createdAt, granary version, sqlite version, user_version,
  page_count, per-table row counts, sizes + sha256 of raw/compressed/sealed,
  compression `{alg:'zstd', level}`, encryption `{alg:'AES-256-GCM',
  chunkSize, kekId, wrappedDek, nonceBase}`.
- **Bucket prerequisites** (checked by "test connection": PUT, stat, list,
  GET, DELETE of a probe object under `<prefix>/.ops-probe/`): bucket exists
  (ops never creates it), versioning or object lock recommended
  (ransomware/fat-finger protection — reported, not required), a lifecycle
  rule `AbortIncompleteMultipartUpload` ≤ 7 days (shown as a checklist item,
  since Bun can't list multipart uploads).
- **Retention** per destination, GFS: keep all < 48 h, 1/day for 14 days,
  1/week for 8 weeks, 1/month for 12 months (defaults, editable). Only
  manifests are listed/counted; orphaned data objects without a manifest older
  than 24 h are deleted.
- **Credentials** least privilege: documented IAM policy (Put/Get/List/Delete
  on the prefix only). Delete permission is needed for retention; with object
  lock, retention deletes become no-ops and are reported as such.

## Consequences
Two objects per backup. Restores and drills only trust manifests.
