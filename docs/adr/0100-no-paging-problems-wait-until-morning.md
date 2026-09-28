# 100. No paging: the system self-heals; problems wait until morning

Date: 2026-09-28 · Status: proposed · Supersedes 88

## Context
"I want to sleep and this is not critical." Nothing may wake the user.
"Let me sleep at night" now means: backups and telemetry keep flowing
without human intervention, the system fixes what it can, and whatever it
can't fix is waiting — clearly explained — on the next visit.

## Decision
- **No notification channels, no external heartbeat/dead-man's switch.**
  The `notifier/*` and `heartbeat/main` actors, the `notify`/`heartbeat` I/O
  processors, the notifications outbox and the notification UI are removed
  from the plan.
- Watchdog signals are still computed (`watchdog/main` → `condition/<id>`
  actors, renamed from `alert/*`) but classified into only **three states**:
  - **ok**;
  - **handled** — a self-healing action ran (ADR 0101) and the condition
    cleared; recorded as an *info* event, never surfaced as a problem;
  - **attention** — needs a human *when convenient*: persisted, shown in the
    admin UI banner and `/ops`, exported to Grafana (log line + metric).
  There is no "warn/crit" and no `for` hysteresis tuning for paging; a
  condition becomes *attention* only after self-healing was tried and the
  condition persisted for its grace period.
- **The calmer signal set** (defaults; grace periods are long on purpose):

| Condition | Self-healing first | Attention when |
|---|---|---|
| No verified **off-site** backup within 3 × effective interval | retry with backoff; re-seal; stretch interval if egress-limited | still none after 12 h |
| R2 auth / bucket errors (`AccessDenied`, `SignatureDoesNotMatch`, `NoSuchBucket`) | keep the local copy, retry hourly | persists 2 h (can't self-heal) |
| Restore drill failed | re-run drill once on the next backup | fails twice in a row |
| Disk: backup can't start (ADR 0098 budget) | spool cleanup → drop local copy → WAL checkpoint → postpone | still blocked after 3 attempts |
| Disk free < 20 % or < 2 × DB size | same as above | persists 24 h |
| Retention floor exceeds `maxBytes` (ADR 0096) | — | immediately (config decision) |
| Telemetry sink down (circuit open) | buffer, drop oldest, half-open probes | persists 24 h |
| granary outbox `dead` rows > 0 | — (granary's relay already retried 6×) | immediately |
| granary quarantined actors > 0 | — | immediately |
| granary outbox oldest pending > 1 h | — (relay retries) | persists 6 h |
| No webhook received | — | 7 days |
| Master key missing / KEK undecryptable backups | — | immediately |

  Dropped as noise for this lens: event-loop lag, RSS (kept as metrics only,
  exported to Grafana), dead-letter rates, telemetry drop ratios (metrics
  only), clock skew (self-heals via retry; surfaces through the auth row if
  persistent).
- **"While you were away" banner**: every admin page shows a banner when
  there are attention items not yet acknowledged, or handled events since
  the admin's last visit: "Since yesterday 23:10: 4 things handled
  automatically, 1 needs you: R2 token rejected since 02:14 — backups are
  kept locally." Acknowledge per item; items reappear if they recur.
- `status().sleepOk` = no *attention* items open **and** a verified off-site
  backup within its window **and** the last drill passed. It is shown, not
  pushed.
- Grafana receives the same facts as metrics (`ops_condition_state{id}`,
  `ops_backup_age_seconds`, …) and log lines, so dashboards show them; ops
  ships no Grafana alert rules (the user may add some later — that would be
  their explicit choice to be woken).

## Consequences
A total outage (VM down) is noticed only on the next visit or in Grafana —
accepted by the user ("this is not critical"). Backups continue off-site as
long as the VM runs.
