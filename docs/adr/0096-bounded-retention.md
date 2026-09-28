# 96. Retention is bounded: hard caps, convergent pruning, no archive tier

Date: 2026-09-28 · Status: proposed · Partially supersedes 84 (retention)

## Context
The user accepted the GFS schedule (hourly 48 h, daily 14 d, weekly 8 w,
monthly 12 m) but backups are **for operational continuity, not an archive**:
the total must be bounded, and pruning must always converge.

## Decision
- **Selection** per destination and database: keep every backup < 48 h old,
  the newest per day for 14 days, per ISO week for 8 weeks, per month for
  12 months. That is at most 48 + 14 + 8 + 12 = **82 backups** per database
  (164 objects incl. manifests).
- **Hard caps** per destination (schema-required, UI-editable within limits):
  - `maxBackups` default 82 × number of databases, max 200;
  - `maxBytes` default **8 GiB** (R2's free tier is 10 GB-month; leaves room
    for in-flight uploads), max 100 GiB.
  If the GFS selection exceeds a cap, drop from the **oldest** tier first
  (monthly → weekly → daily → hourly), oldest within a tier first, until both
  caps hold — but never below the **floor**: the newest 3 verified backups
  per database are always kept. If the floor alone exceeds `maxBytes`, keep
  the floor and raise an *attention* item (ADR 0100) — nothing else is kept.
- **Make room before writing**: before an upload the retention plan is
  recomputed as if the new backup (estimated size = last sealed size × 1.1)
  already existed; deletions happen first, so the cap is never exceeded by
  more than one in-flight backup.
- **Convergence**: the plan is a pure function of (listing of manifests,
  now, caps). Repeated runs on the same listing produce the same deletions;
  after deleting, a fresh listing is planned again until the plan is empty
  (bounded to 5 iterations, then attention). Deletes are idempotent
  (manifest first, then data, ADR 0082). Orphans (data without manifest
  > 24 h, manifests whose data object is missing) are always deleted.
  Unknown objects under our prefix that don't parse as ours are **not**
  deleted but counted into `maxBytes` and reported.
- **No archive tier**: `storageClass` is fixed to STANDARD (STANDARD_IA has a
  30-day minimum storage duration and retrieval fees, and exists for
  archives); no transition lifecycle rules; the schema has no field for it.
- **Local copies** (`local-dir` on the VM disk) are capped separately and
  tighter (ADR 0098): at most 1 copy, and only while the disk budget allows.
- **Projected storage** in the UI per destination: steady-state count ×
  current average sealed size (+ growth trend from the last 14 days of
  sizes) vs caps, e.g. "82 backups × 41 MiB ≈ 3.3 GiB of 8 GiB; at the
  current growth the cap is reached in ~9 months, then the oldest monthly
  backups are dropped first". Also projected monthly upload egress (ADR
  0098).
- "Don't prune when sick" (ADR 0082) is narrowed: while recent uploads fail,
  retention deletes nothing *except* to honour caps — the caps always win.

## Consequences
Storage cost is bounded by configuration, visible in advance, and the
system degrades by forgetting the oldest history first.
