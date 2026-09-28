# 88. The watchdog: what "sleep at night" means, and who wakes you

Date: 2026-09-28 · Status: proposed

## Decision
`watchdog/main` samples every 30 s; each rule is an `alert/<ruleId>` actor
(`ok → pending → firing → resolving → ok`, `for` durations as hysteresis,
silences with expiry and a reason). Firing/resolved transitions enqueue
notifications (durable outbox, dedupe key `<ruleId>:<firingSince>`).
Default rules (thresholds editable in the UI):

| Area | Rule | Warn | Crit |
|---|---|---|---|
| Backups | age of newest *verified* backup per plan × destination | > 2× interval | > 3× interval, or none 1 h after the plan was created |
| Backups | consecutive failed runs of a plan | ≥ 2 | ≥ 4 |
| Backups | only same-disk destinations verified | always (until off-site verified) | — |
| Uploads | destination auth errors (`SignatureDoesNotMatch`, `AccessDenied`, `NoSuchBucket`) | — | any, for 5 min |
| Uploads | clock skew (`RequestTimeTooSkewed`) | any | — |
| Restore | last successful restore drill | > 8 days | failed drill, or > 15 days |
| Disk | free space on data volume | < 15 % | < 5 % or < 2.2 × DB size (backup can't run) |
| Disk | WAL file size | > 256 MiB for 10 min | > 1 GiB |
| Telemetry | dropped / produced per sink over 15 min | > 1 % | > 20 % or circuit open > 30 min |
| granary | outbox oldest pending age | > 10 min | > 1 h |
| granary | outbox `dead` rows | — | > 0 |
| granary | inbox oldest pending age | > 5 min | > 30 min |
| granary | quarantined actors (fault hook) | — | > 0 |
| granary | dead letters rate | > 10 / 15 min | — |
| granary | no webhook received | > 7 days (configurable; "is the hook still installed?") | — |
| Process | event loop lag p99 | > 200 ms for 5 min | > 1 s for 5 min |
| Process | RSS | > 1 GiB | > 2 GiB |
| Ops | master key missing / decrypt failures | — | any |
| Ops | notification channel failing | > 15 min (shown in UI; also sent via other channels) | — |

- **Notification channels** (`notifier/<channelId>`): generic webhook (JSON,
  optional HMAC), Slack incoming webhook, ntfy.sh topic (phone push), and
  email via an HTTP mail API webhook. Routing: crit → all channels, warn →
  channels marked "include warnings"; quiet hours per channel downgrade warn
  (never crit). A daily digest of warnings is optional.
- **Dead-man's switch**: `heartbeat/main` pings an external check URL
  (healthchecks.io, Cronitor, Better Stack, Grafana OnCall heartbeat) every
  5 min **only while no crit alert fires** and the process is healthy — so a
  dead box, a dead process *or* an unresolved crit all end up as a missed
  heartbeat off-box. The OTLP `ops_up` gauge allows the same via a Grafana
  alert rule.
- **The overview answer**: `status().sleepOk` is true iff no crit is firing,
  no warn has fired for > 24 h, an off-site backup was verified within its
  window, the last restore drill passed, and a heartbeat was delivered within
  10 min. The `/ops` page leads with that yes/no and the reasons.

## Consequences
Every signal must be reachable through `OpsHost.health()` or ops' own DB;
new granary signals extend the contract first.
