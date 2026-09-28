# 115. Remediations contributed by the backups feature

Date: 2026-09-28 · Status: accepted · Amends 101

## Decision
Through `OpsFeature.remediations` (ADR 0123 seam) the backups feature provides:
- `drop-local-copy`: delete all `local-dir` backup files (they are for fast
  restores, not safety).
- `postpone-backup`: no-op with an explanation — runs already postpone
  themselves while the disk rule fails (`snapshot.failed disk-insufficient`
  → run `postponed`).
- `stretch-interval`: double the plan's effective interval (max 6 h, or the
  configured interval if larger). The next egress refresh after a run may
  bring it back when the budget allows.
- `retry-upload`: send `upload.retry` to uploads waiting in `retry-wait` (for
  the plan subject); if none, start a manual run of the plan.
- `rerun-drill`: `drill.run-now` for the subject destination (or all enabled).
Each records a `handled` item when it changed something.
