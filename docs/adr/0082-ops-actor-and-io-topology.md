# 82. Ops actor and I/O processor topology

Date: 2026-09-28 · Status: proposed · Partially superseded by 101

## Decision
One file per actor in `src/lib/ops/actors/`. All side effects go through I/O
processors in `src/lib/ops/io/`; actors hold only non-secret data and
*secret references* (ADR 0086).

| Address | Lifetime | Role |
|---|---|---|
| `ops-config/main` | spawned at boot from ops.sqlite | owns the config snapshot (non-secret); on `config.changed {area, id}` (posted by OpsBackend *after* the DB commit) re-reads and sends `config.updated` to the affected actors; spawns/destroys per-item actors |
| `backup-plan/<planId>` | one per plan | schedule: `idle → armed (delayed send "tick") → dispatching → armed`, `paused`. Next due = last *started* run + interval, computed from `backup_runs` so restarts re-arm; missed windows collapse into one catch-up run |
| `backup-run/<runId>` | virtual (loader from `backup_runs`) | `restore → snapshotting → sealing → uploading → finalizing → succeeded | partial | failed`. `uploading` invokes one `upload/<runId>.<destId>` per destination and waits for all |
| `upload/<runId>.<destId>` | virtual (loader from `uploads`) | `restore → probing → uploading → committing → verifying → done`, `retry_wait` (delayed send, backoff 30 s → 30 min), `failed` after N |
| `retention/<destId>` | one per destination | daily: `idle → listing → planning → deleting → idle`; never prunes the newest verified backup; refuses to prune while the destination's last 3 uploads failed ("don't prune when sick") |
| `restore-drill/<destId>` | one per destination | weekly: `idle → fetching → opening → checking → idle`; downloads latest manifest+artifact, decrypts, verifies sha256, `PRAGMA integrity_check`, compares row counts with the manifest; records RPO/RTO |
| `telemetry-sink/<sinkId>` | one per sink | `idle ⇄ sending`, `backoff`, `open` (circuit) → `half_open`; bounded byte buffer, drop-oldest, drop counters (ADR 0085) |
| `watchdog/main` | spawned at boot | every 30 s samples `host.health()`, ops.sqlite, disk (`fs.statfs`), sink counters; posts `signal.sample` to each alert actor |
| `alert/<ruleId>` | one per rule | `ok → pending (for: duration) → firing → resolving → ok`, `silenced` (until time); on `firing`/`ok` transitions enqueue notifications (ADR 0088) |
| `notifier/<channelId>` | one per channel | drains the notification outbox for its channel via the `notify` processor; `idle ⇄ sending`, `retry_wait`, `failed` |
| `heartbeat/main` | spawned at boot | every `interval` pings the external dead-man's switch *only if* no critical alert is firing; `idle → pinging → idle` |

I/O processors (the only code that performs side effects):

| type | does | secrets |
|---|---|---|
| `snapshot` | posts a job to the snapshot Worker: `VACUUM INTO <spool>/<runId>.sqlite.partial` → rename → integrity_check → row counts → zstd → AES-256-GCM (chunked) → sha256s; replies `snapshot.ready {manifest}` / `snapshot.failed` | backup KEK (ADR 0086) |
| `object-store` | `Bun.S3Client` put/stat/list/delete/get per destination kind; replies with typed results; maps `S3Error.code` (`SignatureDoesNotMatch`, `AccessDenied`, `NoSuchBucket`, `RequestTimeTooSkewed`, 5xx) to `store.error {code, retryable}` | destination credentials |
| `otlp` / `loki` | POST a batch; `sink.sent` / `sink.failed {status, retryAfter}` | sink auth |
| `notify` | webhook / Slack / ntfy / email-via-webhook | channel token/URL |
| `heartbeat` | GET/POST the check URL | the URL itself (often secret) |
| `fs` | spool cleanup, statfs | — |

Mail between actors uses the default `scxml` processor. Replies from I/O
processors go to `request.source` via `ctx.post`.

## Crash semantics (per step)
| Crash while… | On restart |
|---|---|
| snapshotting | loader sees `phase=snapshotting`; deletes `<runId>.*.partial` from the spool; re-snapshots (attempt+1, max 3) |
| sealing (compress/encrypt) | same as above (sealing is part of the Worker job; partial files are always `.partial`) |
| uploading data object | multipart upload is abandoned on the provider (see ADR 0084 lifecycle rule); upload actor restarts from `probing`: object key contains the runId, so re-PUT is an idempotent overwrite |
| after data PUT, before manifest PUT | `probing` finds data object but no manifest → re-verify size via `stat`, then write manifest (the manifest is the commit marker) |
| after manifest PUT, before DB update | `probing` finds manifest with matching sha256 → mark `done` without re-uploading |
| retention deleting | delete manifest first (un-commit), then data; both idempotent; re-planned from a fresh listing |
| notification send | notification outbox row with dedupe key; at-least-once, receivers see the key |
| telemetry buffered | lost (by design, counted as dropped on next boot via a persisted "unflushed" gauge) |
