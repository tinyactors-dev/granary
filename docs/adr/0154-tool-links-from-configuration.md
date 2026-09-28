# 154. Links to external tools come from configuration

Date: 2026-09-28 · Status: accepted

## Context
Developers and operators kept needing to remember URLs (Grafana, the storage
console, fake GitHub, fake-infra). Hard-coding localhost URLs in the UI would
be wrong in production, where Grafana lives on an exe.dev VM and backups in R2.

## Decision
- Links are part of the in-product ops configuration (env only seeds them):
  - telemetry sinks already had `grafanaUrl`; seed `OPS_SEED_OTLP_GRAFANA_URL`.
  - destinations gain optional `consoleUrl` (stored beside, not inside,
    `settings`, so editing it never invalidates a passed test connection);
    seeds `OPS_SEED_R2_CONSOLE_URL`, `OPS_SEED_S3_CONSOLE_URL`.
  - Seeds fill a *missing* link on seed-origin rows nobody edited, so an
    existing database picks up a newly added seed env var; user edits are
    never overwritten.
- R2 without `consoleUrl` links to Cloudflare's documented R2 overview,
  `https://dash.cloudflare.com/?to=/:account/r2/overview` (used on
  developers.cloudflare.com/r2/api/tokens/, /r2/buckets/object-lifecycles/,
  /r2/reference/data-location/). Cloudflare documents no bucket-level
  dashboard URL (nor its jurisdiction segment), so we don't derive one; paste
  the bucket page's URL into `consoleUrl` for a deep link. A destination using
  `endpointOverride` (a stand-in) gets no derived link.
- `destinationConsoleLink()` in the ops contract is the one place that decides
  a destination's link; `/ops` uses it on the destination list and detail and
  per upload on backup run detail. The overview's telemetry rows link to each
  sink's Grafana.
- `/__dev`: `Backend.getDevTools()` lists granary's own pages, the fakes
  (from `FAKE_GITHUB_URL`, `FAKE_INFRA_URL`, `LOADGEN_URL`), Grafana links
  (sinks) and storage consoles (destinations) with a reachability probe (any
  answer < 500 = up, 1.5 s timeout). Shown as a Tools card on the overview
  and an "External" group in the dev sidebar.
- Local values: `config/real.env` seeds Grafana `http://localhost:3300/explore`
  and the RustFS bucket view
  `http://localhost:9001/rustfs/console/browser/?bucket=granary-backups&key=granary%2F`
  (verified in the RustFS console); `config/dev.env` links the fake R2 to
  fake-infra's page.

## Consequences
The same code shows the right links locally and in production; in production
set `grafanaUrl` on the sink and optionally `consoleUrl` on the R2 destination
in /ops (or via the seed env vars).
