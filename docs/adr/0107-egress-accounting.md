# 107. Egress accounting: only R2 uploads count; telemetry budget is a volume cap

Date: 2026-09-28 · Status: proposed · Partially supersedes 98 (egress budget), 99 (volume control)

## Context
The user confirmed that VM↔VM traffic on exe.dev (granary → granary-grafana
through `*.int.exe.xyz` or `*.exe.xyz`) is **not** billed as egress. Uploads
to R2 leave exe.dev's infrastructure and are billed as outbound ("Outbound
bandwidth is any traffic that leaves exe.dev's infra. Inbound traffic is
never billed.", <https://exe.dev/docs/billing/usage.md>). R2 does not charge
for ingress; exe.dev does charge for our upload as egress. Downloads from R2
(restore drills, restores) are inbound → free on both sides (R2 has no
egress fees).

## Decision
- **Egress budget = R2 uploads only**: default **20 GiB/month** (confirmed).
  Counted from actual uploaded bytes (sealed artifact + manifest + probe
  objects + failed partial uploads, which also left the VM). The projection
  and the automatic stretch of the hourly tier (ADR 0098) apply only here.
- **Telemetry** does not count against egress. The **5 GiB/month** telemetry
  default (confirmed) is re-purposed as a **volume cap** protecting the
  Grafana VM's disk and ingest: sampling is lowered automatically when the
  month's projected volume exceeds it (errors and lifecycle spans are always
  kept). Exceeding it is `handled`, never `attention`.
- Metrics: `ops_egress_bytes_total{kind="r2-upload"}`,
  `ops_telemetry_bytes_total{sink}`; the UI shows both against their budgets
  under distinct labels ("R2 upload egress (billed)" vs "telemetry volume").

## Consequences
Restore drills may run as often as useful without cost concerns; only the
backup schedule is egress-sensitive.
