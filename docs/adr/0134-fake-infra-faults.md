# 134. Faults in fake-infra

Date: 2026-09-28 · Status: accepted

## Decision
- A fault `{target: s3|otlp|exe-proxy, method?, pathPattern, count, status?,
  s3Code?, retryAfterSec?, latencyMs?, dropConnection?, corruptBody?}` is
  consumed by the next `count` matching requests (method absent or `*` =
  any; `pathPattern` is an unanchored RegExp tested against the path — for S3
  path **plus query**, so `uploads`, `partNumber` or `uploadId` can be
  targeted). Exhausted faults stay listed with `remaining: 0`.
- Effects apply in order: latency, then drop, then status. Without `status`
  the request proceeds after the delay. S3 status faults render S3 XML with
  `s3Code` (defaults: 503/429 → `SlowDown`, 403 → `AccessDenied`, else
  `InternalError`) and `Retry-After` when given.
- `dropConnection`: the response body errors in `pull`, which makes Bun close
  the socket mid-response (an error in `start` did not). **Bun's S3 client
  retries network errors 3 times**, so a drop (or 5xx) with `count: 1` is
  healed transparently; tests that want a failure need `count ≥ 4`.
- `corruptBody`: on GET the served bytes are flipped (download corruption); on
  PUT/part the *stored* bytes are flipped while the ETag keeps the MD5 of what
  was sent (bit rot) — both are caught by manifest checksums in drills.
- Schema fix: the pinned `FakeInfraState.faults` item was
  `Intersect([InjectFaultRequest, {id, remaining}])`, which never validates
  because `InjectFaultRequest` is closed. It is now `FakeFault`, the merged
  object — every previously valid value is still valid.
