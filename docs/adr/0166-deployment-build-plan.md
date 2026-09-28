# 166. Deployment readiness: milestones and parallel fork split

Date: 2026-09-28 · Status: accepted

## Pinned contracts (written with this ADR, schemas/interfaces only)
- `src/lib/schemas/cli.ts` — command catalogue, data-dir layout, exit codes.
- `src/lib/schemas/admin-socket.ts` — socket protocol (ADR 0159).
- `src/lib/schemas/admins.ts` — admins, login links, setup state, audit.
- `src/lib/schemas/github-app.ts` — connection mode, manifest, conversion,
  app/installation/repo rows and DTOs, app hook deliveries, secret refs.
- `src/lib/schemas/health.ts` — `/healthz`, `/readyz`.
- `src/lib/platform/secrets/contract.ts` — `PlatformSecrets` (ADR 0158) +
  ast-grep rule `platform-is-a-leaf.yml`.
- `Backend` additions (settings/admins/login links/GitHub) with StubBackend
  implementations and `BackendError('unavailable')` placeholders in the real
  backend.
- `fake-github/schemas.ts` additions (ADR 0164).

## Milestones
- **D1 — runs anywhere:** data dir + master key + CLI + socket + admins +
  login links + health (E1), packaging (E2).
- **D2 — GitHub in-product:** app manifest flow, installation tokens, repo
  policy, app OAuth, catch-up (E3), fake parity + tests (E4), settings UI (E5).
- **D3 — documented & released:** manual, end-to-end wizard test, clean-host
  `release:verify` (E6).

## Parallel forks (E1–E5 in parallel after this ADR; E6 last)

| Fork | Owns | ADRs |
|---|---|---|
| **E1 platform & CLI** | `src/lib/platform/**` (move of `src/lib/ops/secrets/**`, with ops updated to import it), master key rename/aliases, data-dir & config-source resolution (`src/lib/server/config.ts`, `src/lib/schemas/config.ts`: remove REQUIRED_SECRETS, add new keys), granary.sqlite migrations for `admins`, `login_links`, `audit_log`, `secrets`, `settings` (kv), `src/lib/server/admins.ts`, `src/lib/server/admin-socket.ts`, `src/cli/**` → `dist/cli.js` (all commands except `github *` handlers' server side), `src/routes/auth/link/**`, `src/routes/healthz/+server.ts`, `src/routes/readyz/+server.ts`, `src/hooks.server.ts` (locals.setupState, first-run redirect), real Backend methods for admins/login links/setup state, `boot.ts` wiring, mise task `cli` (build) | 0170–0179 |
| **E2 packaging & release** | `release/` generator `tools/release/**`, mise tasks `release:pack`, `release:verify`, `release:publish`, `CHANGELOG.md`, `LICENSE` (confirm with user: MIT like tinyactors), fnox `prod` ref `NPM_TOKEN`, `.gitignore` (`release/`), pitchfork usage for the verify container | 0180–0189 |
| **E3 GitHub App backend** | granary.sqlite migrations for `github_app`, `github_installations`, `github_repos`, `manifest_states`; `src/lib/server/github/**` (app JWT, installation tokens, client factory by mode, manifest conversion, installation sync, seeds for token mode), relay/`github-client.ts` auth changes, `inbound.ts` (secret from store, repo policy, installation events, 503 in `none`), `oauth.ts` (app OAuth), `src/routes/settings/github/callback/+server.ts`, `src/routes/settings/github/installed/+server.ts`, `src/lib/server/actors/delivery-catchup.ts` + I/O processor, real Backend GitHub methods, catch-up metrics/condition hook | 0190–0199 |
| **E4 fake GitHub parity + tests** | `fake-github/**` (ADR 0164; schemas additive), `tests/github-app*.test.ts`, `tests/catchup.test.ts`, `tests/cli.test.ts`, harness additions (additive) | 0200–0209 |
| **E5 settings UI** | `src/routes/settings/**` pages (`+page.svelte`, `+page.server.ts` only for form posts to GitHub), `src/lib/components/settings/**`, `src/lib/remote/settings.remote.ts`, nav entry "Settings", setup banner component (rendered by the root layout — small edit) — develops against StubBackend | 0210–0219 |
| **E6 manual & integration** (after E1–E5) | `docs/manual/**`, `mise run docs:cli`, end-to-end wizard test, fixing seams, running `release:verify` | 0220–0229 |

Shared-file rules as in ADR 0110: small targeted additive edits, re-read
before editing, migrations append-only at the end, `check:boundaries` green,
only E4 and E6 run `mise run test` while others are active (build output is
shared); others run `mise run check` + `check:boundaries`.
