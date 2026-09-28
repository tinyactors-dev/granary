# 191. GitHub App auth: JWT via node:crypto, cached installation tokens, per-repo clients

Date: 2026-09-28 · Status: accepted · Refines 0160

## Decision
- **App JWT** (`app-jwt.ts`): RS256 with `node:crypto` `sign` (built into
  Bun), `iat = now − 60 s`, `exp = iat + 10 min` (≤ GitHub's maximum),
  `iss = app id`. ADR 0160 said WebCrypto; WebCrypto cannot import GitHub's
  PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) without re-wrapping, `createPrivateKey`
  takes it directly. The PEM is validated at manifest completion.
- **Installation tokens**: `POST /app/installations/{id}/access_tokens`,
  cached per installation until 5 min before `expires_at`, one in-flight
  request per installation, dropped on a 401.
- **Relay**: instead of adding `installationId` to the outbox payload (ADR
  0160), the relay resolves a client per effect:
  `GitHubConnection.clientForRepo({owner, repo, repoId})` → token mode: the
  PAT; app mode: the repo's installation from `github_repos`, else
  `GET /repos/{owner}/{repo}/installation` (JWT), stored for next time. No
  actor or outbox schema change; rows queued before the switch keep working.
- `github-client.ts` gains `githubRequest` (shared by app calls), a token
  *provider* (`TokenSource`), `onUnauthorized`, header access (`Link`) and
  `nextLink` for cursor paging.

## Consequences
The effect path is unchanged in token mode. Resolution failures are normal
relay failures (retry with backoff, then `dead`).
