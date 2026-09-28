# 27. A "real" local stack for the ops targets (RustFS + Grafana LGTM)

Date: 2026-09-28 · Status: accepted

## Context
fake-infra (ADR 0103/0130) is ideal for tests and fault injection, but it has
no UI of its own to look at backups or telemetry. To click around the actual
ops targets locally we want a real S3 implementation and a real Grafana.

## Decision
- Two more pitchfork daemons wrapping mise tasks (docker via colima):
  - `granary/rustfs` → `mise run infra:rustfs`: `rustfs/rustfs`, S3 API on
    :9000, console on http://localhost:9001/rustfs/console/ (login `granary-dev` /
    `granary-dev-secret`), data in the docker volume `granary-rustfs`.
  - `granary/grafana` → `mise run infra:grafana`: `grafana/otel-lgtm`
    (Grafana + Loki + Tempo + Prometheus + collector), UI on
    http://localhost:3300 (admin/admin), OTLP on :4317/:4318, data in the
    volume `granary-lgtm`.
- `granary/app-real` → `mise run dev:real`: the dev server with
  `config/real.env` layered over `config/dev.env`: a separate data dir
  (`data/real/`, so ops seeds apply fresh), an S3 destination seeded at
  RustFS (bucket created idempotently by `tools/dev/s3-create-bucket.ts`,
  since Bun's S3 client cannot create buckets), 10-minute backups, and the
  seeded OTLP sink pointed at Grafana without auth. The R2 destination still
  points at fake-infra, so both kinds are visible.
- `app` and `app-real` share port 5173 and are mutually exclusive:
  `mise run up` stops `app-real` and starts `app`; `mise run up:real` stops
  `app` and starts `app-real` plus RustFS and Grafana. `pitchfork start -l`
  is no longer used (it would start both). `down:real`, `logs:real` exist.
- granary's own log lines (`src/lib/server/log.ts`) are now exported as
  OTLP/JSON logs (`service.name=granary`) through the ops telemetry sinks
  (`src/lib/server/log-export.ts`), so Loki shows application logs next to
  Tempo traces and Prometheus metrics. Lines about the telemetry pipeline
  itself are not exported (no feedback loop).

- Containers run through `tools/dev/container.sh <name> …`: it removes a
  leftover container with that exact name before `docker run`, and on
  SIGTERM/SIGINT runs `docker stop <name>` and waits. Without it, stopping the
  pitchfork daemon did not wait for the container, so `pitchfork start -f`
  raced colima's `ssh` port forward ("port 9000 is already in use by process
  'ssh'"). Removal is by exact container name only, never by pattern.

## Consequences
`mise run up:real` gives a clickable local version of the production ops
targets. Docker (colima) must be running. Tests keep using fake-infra.
