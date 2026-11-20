# Changelog

All notable changes to `@tinyactors/granary` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/). `release:publish`
refuses to publish a version without a `## [<version>]` entry (ADR 0182).

## [Unreleased]

## [0.2.0] - 2026-11-20

### Changed
- granary runs on `@tinyactors/node` 0.4.0 (ADR 0300): every actor (the app,
  ops, the fake GitHub, fake-infra and the load generator) is an SCXML chart
  built in TypeScript, issue actors are started from SQLite when something is
  sent to them, and traces name each actor and chart natively.
- The admin section is available in every environment, with each area gated
  by a capability; the app is reorganised around Activity and Policy with one
  glossary (item, delivery, decision, action).
- Readable labels, issue and pull-request badges, and production copy that
  does not name the host.
- On phones, tables stack into cards and the navigation is a drawer.

### Added
- Pull requests from people who aren't allowed are closed like issues
  (with the GitHub App's pull-request permission).
- Configurable closing-message templates, with an editor and a preview.
- A blocklist that beats the allowlist and maintainer associations, with
  expiry.
- Structured logs, an HTTP access log, and log–trace correlation.
- `/admin/deliveries` lists webhooks that aren't about an item.
- A colored wheat logo, favicons, app icons, and a guided GitHub App logo
  upload.

### Removed
- The DAP debugger, `/admin/debugger`, `GRANARY_DEBUGGER` and
  `GRANARY_DAP_PORT`: `@tinyactors/node` 0.4.0 has no debug adapter.
- The actor inspector no longer shows mailbox contents, step counters,
  residency, scheduling or internal events, which 0.4.0 does not expose.

### Fixed
- Accessibility: no axe violations on the audited pages, a keyboard-reachable
  trace list, heading order and a skip link.
- The setup checklist is computed from the real state.
- Release packing builds the exported tree outside the repository and passes
  option values to its steps.

## [0.1.0] - 2026-09-28

### Added
- In-product GitHub App connection (manifest flow, installation tokens,
  per-repository enable switch, sign-in via the app) and catch-up of missed
  webhook deliveries.
- `granary` CLI: `init`, `serve`, `admin`, `login-link`, `config`, `backup`,
  `restore`, `doctor`, `systemd-unit`; `/healthz` and `/readyz`.
- Release channels: `dev` builds (`<x.y.z>-dev.<epoch>.g<sha>`, dist-tag `dev`)
  and stable releases (dist-tag `latest`), one release script for the laptop
  and a manual GitHub Actions workflow that publishes with npm provenance.
- Auto-close GitHub issues opened by users who are not on the allowlist (or
  not OWNER/MEMBER/COLLABORATOR), built on `@tinyactors/node` statecharts
  with an application-level SQLite write-ahead log (inbox/outbox).
- Admin UI (SvelteKit + shadcn-svelte): deliveries, effects, verdicts, issue
  detail, allowlist, live actors and an actor inspector.
- Operations module: encrypted SQLite backups to S3-compatible storage /
  Cloudflare R2 with retention caps and restore drills, OTLP telemetry to
  Grafana (Loki, Tempo, Prometheus), a self-healing watchdog and `/ops` pages.
- `granary` command-line interface and npm distribution (`@tinyactors/granary`).
