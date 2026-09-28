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

**Test** posts an empty request for each signal and shows the answers.
**Save**. A new sink is saved disabled; switch **Enabled** on and **Save**
again to start exporting.

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
- **Logs**: structured records, labelled `service_name` in Loki
  (`granary` for the app, `granary-ops` for backups and ops). Each record has
  a readable body plus attributes (see below); records logged while handling
  a request carry its trace id, so Grafana jumps from a log line to the trace.
  Lines about the telemetry pipeline itself are not exported. Set
  `GRANARY_LOG_LEVEL=debug` in `granary.env` for health-probe and asset
  requests and other debug records.
- **Metrics**, among others:
  - `ops_backup_age_seconds`, `ops_attention_items`, `ops_disk_free_bytes`
  - `granary_outbox_pending`, `granary_outbox_dead`, `granary_inbox_pending`
  - `granary_catchup_redelivered_total`, `granary_catchup_failing`
  - `granary_event_loop_lag_p99`, `granary_rss_bytes`

Secrets are scrubbed from everything that is exported.

## Seeding a sink from the environment

For automated installs a sink can be seeded once with `GRANARY_SEED_OTLP_ENDPOINT`,
`GRANARY_SEED_OTLP_AUTH` (`none`, `bearer`, `basic`, `exe-peer`,
`exe-vm-token`, …), `GRANARY_SEED_OTLP_TOKEN` and `GRANARY_SEED_OTLP_GRAFANA_URL`
in `granary.env`, before the first start. A seeded sink starts **enabled**
(you asserted it); one that needs a token starts disabled until the token
exists. After that it is edited in the UI like any other sink.

## One Grafana for several services

A single `grafana/otel-lgtm` instance can serve all your services: each one
exports with its own `service.name`, so Loki, Tempo and Prometheus keep them
apart. [Appendix: exe.dev](appendix-exe-dev.md#2-a-shared-observability-vm)
shows the setup with a private VM, credential-free VM-to-VM delivery and
Grafana signing users in via exe.dev.

## Logs: what is recorded

| Record | Level | Key attributes |
|---|---|---|
| HTTP access log `GET /ops 200 12ms` (every request) | info; 5xx error; `/healthz`, `/readyz`, assets debug | `http.request.method`, `http.route`, `url.path`, `http.response.status_code`, `duration_ms`, `client.address`, `user.login` |
| Webhook outcome `webhook: issues.opened accepted` | info (bad signature: warn) | `github.event`, `github.action`, `github.delivery_id`, `github.repository`, `github.issue.number`, `webhook.outcome` (accepted/ignored/duplicate), `webhook.reason` |
| Issue verdict `issue/… finished: closed (not-allowed)` | info | `granary.issue_key`, `granary.verdict`, `granary.reason` |
| GitHub effect `relay: close:… done` / retry / gave up | info / warn / error | `relay.effect_key`, `relay.attempts`, `github.repository`, `error.message` |
| Missed-webhook catch-up pass | info (partial/failed: warn) | `catchup.outcome`, `catchup.missed`, `catchup.redelivered` |
| Sign-in | info (refused/invalid: warn) | `auth.method` (github/login-link), `auth.outcome`, `user.login` |
| Admin, allowlist, settings, secret, sink changes | info | `audit.action`, `audit.subject`, `audit.actor` |
| Backup run started / succeeded / failed (`granary-ops`) | info (failed/partial: warn) | `backup.run_id`, `backup.plan_id`, `backup.database`, `backup.state`, `backup.sealed_bytes`, `duration_ms` |
| Upload done / retrying / failed (`granary-ops`) | info / warn / error | `backup.run_id`, `backup.destination_id`, `backup.attempts`, `error.code` |
| Retention pass, restore drill (`granary-ops`) | info (nothing deleted: debug; drill not ok: warn) | `retention.deleted`, `drill.result`, `drill.rpo_ms` |
| Unexpected errors | error | `exception.type`, `exception.message`, `exception.stacktrace` |

Never logged: cookies, request bodies, login-link tokens (`/auth/link/[redacted]`),
OAuth `code`/`state` and other sensitive query values (`[redacted]`), attributes
named like tokens/secrets/passwords, and — at export — any registered secret value.

## Useful LogQL

Loki's OTLP ingestion turns attributes into structured metadata (dots become
underscores), so filter with `| key="value"` after the stream selector:

```logql
# everything that went wrong, both services
{service_name=~"granary|granary-ops"} | detected_level=~"error|warn"

# webhook outcomes (and why deliveries were ignored)
{service_name="granary"} | webhook_outcome!="" | line_format "{{.webhook_outcome}} {{.github_repository}}#{{.github_issue_number}} {{.webhook_reason}}"

# issues closed per hour
sum by (granary_verdict) (count_over_time({service_name="granary"} | granary_verdict!="" [1h]))

# 5xx rate and slow requests
sum(count_over_time({service_name="granary"} | http_response_status_code=~"5.." [5m]))
{service_name="granary"} | duration_ms > 1000

# backup results and failing uploads
{service_name="granary-ops"} | backup_state!=""
{service_name="granary-ops"} |= "upload" | detected_level=~"warn|error"

# who changed what
{service_name=~"granary|granary-ops"} | audit_action!=""

# scanners probing the public site
topk(10, sum by (url_path) (count_over_time({service_name="granary"} | http_response_status_code="404" [24h])))
```

