# src/lib/server/github — the GitHub connection (ADR 0160, 0162, 0190–0194)

| File | What |
|---|---|
| (tables) | `github_settings`, `github_app`, `github_installations`, `github_repos`, `manifest_states` are part of granary.sqlite's baseline migration (`../wal.ts`, ADR 0230) |
| `store.ts` | `GitHubStore`: typed rows over those tables |
| `app-jwt.ts` | RS256 app JWT, `InstallationTokenCache` (ADR 0191) |
| `connection.ts` | `GitHubConnection`: mode (`none`/`app`), secrets, webhook secret, repo policy, lifecycle events, per-repo installation-token clients, OAuth credentials, manifest flow, installation sync, hook deliveries, status |
| `dev-autoconnect.ts` | dev/tests: create the app on the fake GitHub and enable auto-install (`GRANARY_DEV_GITHUB_AUTOCONNECT`, ADR 0230) |
| `webhooks.ts` | TypeBox subsets of `installation` / `installation_repositories` payloads |
| `catchup.ts` | `github-app` I/O processor + messages for `delivery-catchup/main` (ADR 0162, 0194) |

The runtime owns one connection: `getRuntime().github`. The actor chart is in
`../actors/delivery-catchup.ts`.
