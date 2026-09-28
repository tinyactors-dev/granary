# 90. fake-infra: stand-ins for object storage, Loki, OTLP and notifications

Date: 2026-09-28 · Status: proposed

## Decision
`fake-infra/` is a separate Bun process (like `fake-github/`, ADR 0060) with
its own tinyactors System (one actor per file in `fake-infra/actors/`) and
TypeBox schemas in `fake-infra/schemas.ts`. Default port `FAKE_INFRA_PORT`
4090, pitchfork daemon `fake-infra`, `mise run fake-infra`.

Surface:
- **S3-compatible object store** at `/s3/…` (path-style): PUT/GET/HEAD/DELETE
  object, `GET ?list-type=2` (prefix, continuation token, max-keys),
  multipart (`?uploads`, `?partNumber&uploadId`, complete, abort,
  `?uploads` listing), `ETag` incl. multipart `-N` suffix. SigV4
  verification on by default (so wrong keys produce `SignatureDoesNotMatch`
  XML, the same `S3Error.code` Bun surfaces), clock-skew check. Buckets are
  created via the control API only (mirrors reality: ops never creates
  buckets). Storage in memory or on a temp dir for large objects.
- **Loki**: `POST /loki/api/v1/push` (JSON; snappy-protobuf optional later),
  tenant header, Basic auth, `GET /loki/api/v1/query_range` minimal (label
  matcher only) for tests.
- **OTLP receiver**: `POST /v1/traces|logs|metrics` (protobuf + JSON), stored
  decoded (reusing `decodeTraces`) for queries.
- **Notification sink**: `POST /hooks/<name>` records webhook/Slack/ntfy
  payloads; **heartbeat** `GET|POST /ping/<checkId>` records pings.
- **Control API** `/__control`: `reset`, `buckets` (create/delete, quota
  bytes, object lock on/off), `credentials` (issue/rotate/revoke access keys;
  Loki/OTLP tokens), `faults` (`{target: 's3'|'loki'|'otlp'|'hooks',
  method, pathPattern, status, count, retryAfter, latencyMs, dropConnection,
  corruptBody}`), `disk` (simulate quota exhausted → `507`/`EntityTooLarge`),
  `clock` (skew offset), `state` (objects, received batches, pings, hooks),
  `events` (SSE stream, like fake-github's).
- `GET /` a small page showing buckets/objects, received logs/spans, pings,
  and fault controls.

What runs against the fakes vs the real thing:
- **Fakes** (CI, `mise run test`, dev portal): everything functional —
  scheduling, retries, faults, rotation, retention, alerts, restore drills.
- **Real** (opt-in `mise run test:ops-real`, colima): contract tests only —
  the same object-store and sink test suites run against RustFS
  (`rustfs/rustfs`) and `grafana/otel-lgtm`, proving the fakes are faithful.
  Public MinIO images are no longer pullable, hence RustFS.

## Consequences
The fake store is the most work (SigV4 + multipart); it is also what makes
crash/fault tests deterministic.
