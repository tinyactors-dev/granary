# 101. Ops topology revision: self-healing, no notifier/heartbeat

Date: 2026-09-28 · Status: proposed · Partially supersedes 82 (actor table rows for alert/notifier/heartbeat, I/O processors notify/heartbeat), 89 (notifications table)

## Decision
Actor changes (everything else in ADR 0082 stands):

| Address | Change |
|---|---|
| `notifier/<channelId>`, `heartbeat/main` | **removed** |
| `alert/<ruleId>` | **renamed `condition/<id>`**: `ok → suspect → healing → ok` or `→ attention → ok` (on clear) · `acknowledged` (by an admin; returns to `attention` on recurrence). `healing` sends `remediate {action}` to `remediator/main` and waits for `remediated`/`remediation.failed` or the grace period |
| `remediator/main` | **new**: runs one remediation at a time, in the order of ADR 0100's table: `spool-cleanup`, `drop-local-copy`, `wal-checkpoint-truncate` (own connection, `PRAGMA wal_checkpoint(TRUNCATE)`), `postpone-backup`, `stretch-interval`, `retry-upload`, `rerun-drill`, `reset-sink-circuit`. Every action is logged to `ops_events` (kind `handled`) and exported to Grafana. Remediations never touch granary's data beyond the WAL checkpoint, and never restart granary actors |
| `backup-plan/<plan>` | honours `effectiveInterval` (egress-stretched, ADR 0098) |
| `upload/<run>.<dest>` | seals from the raw snapshot while streaming (ADR 0098); manifest PUT with `If-None-Match: *` (ADR 0095) |
| `retention/<dest>` | caps + convergence (ADR 0096); runs before each upload and daily |

I/O processors: `notify` and `heartbeat` removed; new `remediate` (spool
cleanup, statfs, WAL checkpoint) — `fs` merged into it.

ops.sqlite (ADR 0089): `notifications` removed; `alert_state`/`alert_events`
become `conditions` and `ops_events` (kind `info|handled|attention|ack`,
condition id, message, evidence JSON, at); new `admin_visits(login,
last_seen_at)` for the banner.

Crash semantics for remediations: each is idempotent and re-derivable from
current facts (a checkpoint twice is harmless; spool cleanup is based on
non-terminal runs), so a crash mid-remediation just re-evaluates on the
next watchdog sample.

## Consequences
The watchdog is now a control loop, not an alarm.
