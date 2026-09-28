# 114. Retention implementation details

Date: 2026-09-28 · Status: accepted · Amends 96

## Decision
- `backups/retention-plan.ts` is a pure planner over a listing. A backup is a
  data object + its manifest; *verified* = both present and the data object
  non-empty (no manifest GETs during planning). `createdAt` = manifest
  `lastModified`. Probe objects are ignored; unparseable keys are "unknown"
  (never deleted, counted into `maxBytes`).
- GFS tiers as ADR 0096; a newer backup represents its day/week/month in any
  tier. Caps drop monthly → weekly → daily → hourly, oldest first, never the
  floor (newest `floor` verified per database). Deleting = manifest, then data.
- **Make-room keeps the floor of existing verified backups**: the incoming
  backup is counted but the existing floor is not reduced for it, so a cap may
  be exceeded by exactly the one in-flight backup until the next pass (never
  delete a verified backup before its replacement is verified).
  `floorExceedsCap` is computed from the floor alone, so this does not raise
  attention.
- "Sick" (the destination's last 3 terminal uploads failed): GFS rejects are
  kept at the lowest priority and only caps delete.
- `local-dir` keeps exactly one copy per database (floor 1, max 1), pruned
  after each local upload (`retention.tick` from the upload's `done`).
- The processor loops list → plan → delete until the plan is empty (≤ 5) and
  stores a summary in `kv` under `backups:retention:<destId>`
  (`{at, mode, deleted, freedBytes, converged, floorExceedsCap, unknownObjects,
  sick}`) — the fact source for the `retention-floor-exceeds-cap` condition.
