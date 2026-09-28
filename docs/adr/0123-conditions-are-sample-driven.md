# 123. Conditions are sample-driven; remediations are contributed by features

Date: 2026-09-28 · Status: accepted · Implements 100, 101

## Decision
- `watchdog/main` only ticks (default 30 s, `OPS_WATCHDOG_INTERVAL_MS`); a
  new **`sample`** I/O processor does the reads (`health/signals.ts`: host
  health, `statfs` or `OPS_TEST_STATFS_OVERRIDE`, ops.sqlite, sink states)
  and posts `signal.sample {breached, value, facts, at}` to
  `condition/<kind>[.<subject>]`. Cleared samples go only to conditions that
  already have a row or are resident; non-ok conditions whose subject
  vanished get a cleared sample.
- `condition/<id>` is virtual (loader from the `conditions` row). **Every
  decision is driven by samples, which carry their own time** — suspect →
  healing when confirmed (two consecutive breaches, if the policy asks),
  next ladder step after `settleMs`, attention when the ladder is exhausted
  and `graceMs` since the start passed. No delayed send has to survive a
  restart; a restarted condition resumes from its row (healing resumes as
  suspect, keeping the ladder position; entry side effects are not
  repeated). Policies (ladder, grace, settle, texts) live in
  `health/policies.ts`, following ADR 0100's table.
  `OPS_TEST_GRACE_SCALE` scales grace/settle for tests (additive env).
- A new **`journal`** I/O processor persists the row (ladder bookkeeping in
  `facts._ladder`, stripped from DTOs) and appends the transition's ops event
  (`attention` on escalation; `info` "Resolved…"/"Handled automatically…" on
  clearing; `ack`); a quick blip that clears before any remediation writes no
  event. Attention is also logged as a WARN line that says no page was sent.
- `remediator/main` runs one action at a time via the `remediate`
  processor. Built-in: `spool-cleanup` (files in `<dataDir>/ops-spool` not
  referenced by a non-terminal run and older than 10 min),
  `wal-checkpoint-truncate` (own connection per host DB + ops.sqlite),
  `reset-sink-circuit` (posts `sink.probe`), `lower-sampling`. Features
  contribute others through `OpsFeature.remediations` (backups:
  `drop-local-copy`, `postpone-backup`, `stretch-interval`, `retry-upload`,
  `rerun-drill`); an action nobody provides is a `noop`, never an error.
  Every action that did something is a `handled` event.
- `status().sleepOk` = no attention items **and** a verified off-site
  backup (`uploads.state='done'`) within 3 × effective interval **and** the
  last *finished* drill `ok`. The banner counts `handled` events since the
  admin's last visit (24 h if never) and lists attention items.
- `retention-floor-exceeds-cap.<dest>` reads the backups feature's last retention
  pass from kv `backups:retention:<destId>` (`floorExceedsCap`).
