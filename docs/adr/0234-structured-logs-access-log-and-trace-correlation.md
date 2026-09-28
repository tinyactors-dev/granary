# 234. Structured logs, an HTTP access log, and log ↔ trace correlation

Date: 2026-09-28 · Status: accepted

## Context
In production Loki showed only startup lines for `granary` and two ops
events for `granary-ops`: backup runs, uploads, drills, catch-up passes,
sign-ins, settings changes and HTTP requests logged nothing, and SvelteKit's
own `[404] GET /.env` console lines (scanner traffic) bypassed the logger.
Log lines were plain strings, so Loki could not filter or aggregate them.

## Decision
- **One logger API, structured** (`src/lib/server/log.ts`):
  `log.info(message, ...rest)` where plain-object `rest` items are attributes,
  an `Error` becomes `exception.type/message/stacktrace`. Levels
  `debug < info < warn < error`; `GRANARY_LOG_LEVEL` (default `info`, ADR 0230
  table) drops lower records entirely. Console output is one readable line per
  record for journald: `<iso> <service> [LEVEL] message key=value … trace_id=…`.
- **Services**: `log` is `service.name=granary`; the ops module gets
  `createLogger('granary-ops')` through `OpsHost.log` (the boundary rules are
  unchanged: ops only sees the `OpsLogger` contract, which gained an optional
  `debug`).
- **Export** (`log-export.ts`): OTLP/JSON logs through the ops telemetry
  sinks, one batch per service per second; attributes as OTLP attributes;
  records emitted before the exporter attaches (boot) are buffered (≤ 500) and
  replayed.
- **Access log + request spans** (`request-log.ts`, `hooks.server.ts`):
  every request runs in an AsyncLocalStorage log context with a fresh trace
  id and span id. On completion: one access record (method, route id, path,
  status, duration, client address from `X-Forwarded-For`, user, user agent)
  — 5xx at error, health probes and static assets at debug, everything else
  info — and one OTLP `server` span `METHOD <route id>` exported through the
  Tracer. A webhook posts `issue.opened` with that request's `traceparent`,
  so the issue actor's macrosteps are children of `POST /webhook` and every
  log record of the delivery links to the same trace in Grafana.
- **Domain events** logged at info with attributes: webhook outcome
  (accepted/ignored/duplicate + reason; bad signature at warn), issue
  verdict, relay done/retry/gave-up, catch-up pass summary, sign-ins
  (GitHub/login link, refusals at warn), audited changes (admins, login
  links, GitHub, allowlist, effect retries, ops secrets/destinations/plans/
  sinks — the server's audit listeners, never the offline CLI), backup run
  start/finish, upload done/retry/failed, retention passes (debug when nothing
  was deleted), restore drills, telemetry sink recovery (console only).
- **`handleError`** logs unexpected 5xx errors with their stack and replaces
  SvelteKit's default console output.
- **Redaction**: attribute keys that look like credentials
  (token/secret/password/authorization/cookie/api key/private key/signature)
  are masked at the source; paths redact the login-link token
  (`/auth/link/[redacted]`); query values of `code`, `state`, tokens and
  secrets are `[redacted]`; bodies and cookies are never logged; the ops
  fan-out additionally masks every registered secret value in exported
  batches (ADR 0093).

## Consequences
Loki's OTLP ingestion exposes attributes as structured metadata (dots →
underscores): `{service_name="granary"} | webhook_outcome="ignored"`,
`| duration_ms > 1000`, `| detected_level=~"error|warn"` (verified against
Loki 3.7). Example queries are in `docs/manual/telemetry.md`. Health probes
don't reach Loki unless `GRANARY_LOG_LEVEL=debug`. `tests/logging.test.ts`
asserts records, levels, trace correlation and the absence of secrets at the
collector.
