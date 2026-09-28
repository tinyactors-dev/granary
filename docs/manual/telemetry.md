# Telemetry

granary can send its logs, traces and metrics to any OpenTelemetry (OTLP
over HTTP) endpoint: Grafana Cloud, Grafana Alloy, an OpenTelemetry
Collector, or `grafana/otel-lgtm` for a self-hosted all-in-one Grafana.
Nothing is sent until you add a sink.

## Adding a sink

**Ops → Telemetry → New sink**:

- **Endpoint**: the OTLP/HTTP base URL; granary appends `/v1/traces`,
  `/v1/logs` and `/v1/metrics`.
- **Authentication**:
  - `none`: e.g. a collector on a private network
  - `bearer`: a bearer token
  - `basic`: user and password, e.g. Grafana Cloud's instance id and token
  - `header`: any single header
  - `exe-peer`: exe.dev's VM-to-VM integration injects the key, so granary
    stores nothing
  - `exe-vm-token`: an exe.dev VM token sent as `X-Exedev-Authorization`

  Secrets are stored encrypted and never shown again.
- **Signals**: traces, logs and metrics (all by default).
- **Grafana link** (optional): the URL of your Grafana (for example its
  `/explore` page). granary links to it from Ops.

**Test sink** posts a small request for each signal and shows the answers.

Each sink batches, buffers up to 8 MiB when the endpoint is down (dropping
the oldest data first and counting the drops), backs off, and recovers by
itself. It also has a monthly volume cap (default 5 GiB), which protects a
small Grafana host's disk.

## What is exported

| `service.name` | What |
|---|---|
| `granary` | the webhook, issue and allowlist actors; granary's log lines |
| `granary-ops` | backups, uploads, drills, the watchdog; ops events |

- **Traces**: one span per actor step, named after the actor's family, for
  example `issue macrostep issue.opened`, `issue microstep github.closed`,
  `allowlist macrostep allowlist.check` or `backup-run macrostep
  bootstrap`. The actor's full address (`issue/<repoId>-<number>`) is in
  the attributes `granary.actor.address`, `granary.actor.family` and
  `granary.actor.name`.
- **Logs**: granary's log lines, labelled `service_name` in Loki, e.g.
  `{service_name="granary"}`. Lines about the telemetry pipeline itself
  are not exported.
- **Metrics**, among others:
  - `ops_backup_age_seconds`, `ops_attention_items`, `ops_disk_free_bytes`
  - `granary_outbox_pending`, `granary_outbox_dead`, `granary_inbox_pending`
  - `granary_catchup_redelivered_total`, `granary_catchup_failing`
  - `granary_event_loop_lag_p99`, `granary_rss_bytes`

Secrets are scrubbed from everything that is exported.

## Seeding a sink from the environment

For automated installs a sink can be seeded once with `OPS_SEED_OTLP_ENDPOINT`,
`OPS_SEED_OTLP_AUTH` (`none`, `bearer`, `basic`, `exe-vm-token`, …),
`OPS_SEED_OTLP_TOKEN` and `OPS_SEED_OTLP_GRAFANA_URL`. After that it is
edited in the UI like any other sink.
