# 105. Ops implementation plan, revised

Date: 2026-09-28 · Status: proposed · Supersedes 94

## Pin first (one agent)
M0 — contract & schemas as in ADR 0094, with the revisions: `r2`
destination kind, required caps, no encryption flag, `condition`/`ops_events`
DTOs, banner DTO, remediation catalogue, `exe-peer`/`exe-vm-token` sink auth,
`OPS_TEST_STATFS_OVERRIDE`; fake-infra control schemas incl. R2 fidelity
toggles and the exe.dev proxy fake.

## Then in parallel (four agents, disjoint files)
- **A. Backups**: ops.sqlite, secret store, snapshot Worker with streaming
  seal-into-upload, object-store (`r2`/`s3`/`local-dir`), conditional
  manifest PUT, `backup-plan` (effective interval), `backup-run`, `upload`,
  `retention` (caps + convergence), `restore-drill`, `ops:restore` CLI.
- **B. Telemetry & self-healing**: fan-out + redaction + sampling to the
  egress budget, `telemetry-sink` (otlp-http, exe auth modes), metrics,
  `watchdog`, `condition`, `remediator`, granary `health.ts` provider.
- **C. fake-infra**: S3/R2 fake, OTLP receiver, exe.dev proxy fake, control
  API, page, pitchfork daemon, `/__dev/infra`.
- **D. UI**: `/ops/**` + global banner against the stub backend.

## Finally (one agent)
Integration, ADR 0091/0103 scenarios, contract suites (RustFS/otel-lgtm by
default; R2 and exe.dev when configured), setup doc `docs/ops/exe-dev.md`
(create the Grafana VM from `grafana/otel-lgtm`, retention settings, peer
integration, R2 bucket + token), runbook `docs/ops/runbook.md`.

## Milestones
1. M0 contract.
2. M1 "there is a backup": local-dir + encrypted snapshot + CLI restore.
3. M2 "it's off-site": R2 destination, test connection, secrets, bounded
   retention with projections.
4. M3 "it heals itself": watchdog, conditions, remediator, banner.
5. M4 "I can see it": OTLP to Grafana on exe.dev, metrics, `/ops` overview.
6. M5 "I trust it": weekly drills, leak test, contract suites, a human runs
   the runbook once against R2.
