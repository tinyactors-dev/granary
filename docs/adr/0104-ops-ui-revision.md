# 104. Ops UI revision: banner, projections, no notifications

Date: 2026-09-28 · Status: proposed · Partially supersedes 92

## Decision
- **Removed**: `/ops/notifications`; alert "silences" become per-item
  *acknowledge*.
- **Global banner** in the admin layout (all pages, not only `/ops`): "while
  you were away" summary (ADR 0100), linking to `/ops`. Visible to admins
  and read-only users; acknowledge is admin-only. Backed by a cheap query
  (`OpsBackend.getBanner(login)`), updates `admin_visits`.
- `/ops` overview leads with **"Sleeping is fine"** / **"Needs you (not
  urgent)"**, then: last verified off-site backup per database with age,
  last drill, telemetry flowing (last successful export), attention items,
  and a "handled automatically" timeline for the last 7 days.
- `/ops/destinations`: R2 form (account ID, bucket, prefix, token keys),
  step-by-step test connection (ADR 0095) and the advisory checklist;
  **projected storage** (steady-state count × size vs `maxBytes`/`maxBackups`,
  time until cap at current growth) and **projected egress** vs budget
  (ADR 0096/0098); retention dry-run showing exactly which objects the next
  pass would delete.
- `/ops/telemetry`: `exe-peer` / `exe-vm-token` setup instructions with the
  exact `ssh exe.dev …` commands, test, throughput and drops, Grafana link.
- `/ops/conditions` (was alerts): the ADR 0100 table with current state,
  grace periods, last remediation, acknowledge.
- `/ops/backups`, `/ops/drills`, `/ops/secrets`: unchanged (no encryption
  toggle anywhere).
