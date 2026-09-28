# 165. The operator manual

Date: 2026-09-28 · Status: accepted

## Decision
`docs/manual/` (shipped in the npm package, ADR 0156), Markdown, task-oriented:

1. `README.md` — what granary is, requirements (Linux, Bun ≥ 1.4.1, a public
   HTTPS URL, a GitHub account/org), 10-minute quick start.
2. `install.md` — `bun add -g @tinyactors/granary`, service user,
   `granary init`, storing the master key, systemd unit, reverse proxy/TLS.
3. `first-run.md` — `granary admin add`, `granary login-link`, the setup
   wizard, creating and installing the GitHub App, choosing repos.
4. `allowlist-and-policy.md` — who gets closed and why (ADR 0004).
5. `backups.md` — R2 bucket (EU jurisdiction), bucket-scoped token,
   destinations, plans, retention caps, restore drills.
6. `restore.md` — `granary restore`, disaster recovery from R2 on a new host.
7. `telemetry.md` — Grafana/OTLP sinks, what is exported, `service.name`s,
   span naming (ADR 0155).
8. `upgrades.md` — versioning, upgrade/rollback, migrations are forward-only.
9. `cli.md` — every command (generated from `src/lib/schemas/cli.ts`
   descriptions by `mise run docs:cli`).
10. `troubleshooting.md` — `granary doctor`, `/readyz`, common failures
    (webhook 401, missing key, disk full, missed deliveries).
11. `appendix-exe-dev.md` — example: one exe.dev VM for granary (proxy port,
    `share set-public`), one private VM for Grafana, VM-to-VM integration.

Every command in the manual is exercised by `release:verify` or a test where
possible; the manual is written last (fork E6) against the implemented CLI.
