# 125. Boundary rules match ops module paths only

Date: 2026-09-28 · Status: accepted · Amends 109 (check:boundaries)

## Decision
The ast-grep rules `granary-imports-ops-contract-only` and
`boot-imports-ops-index-only` matched any import path containing `/ops/`, so
`$lib/components/ops/…` (the ops UI's own components) was flagged. They now
match `$lib/ops/…` and relative paths whose first non-dot segment is `ops/`
(`../ops/…`, `./ops/…`). Verified with a probe file: `$lib/ops/system` and
`../ops/features/health` are errors; `$lib/components/ops/…` and
`../ops/contract` pass.
