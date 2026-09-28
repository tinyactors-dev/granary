# Changelog

All notable changes to `@tinyactors/granary` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/). `release:publish`
refuses to publish a version without a `## [<version>]` entry (ADR 0182).

## [Unreleased]

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
