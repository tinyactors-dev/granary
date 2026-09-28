# 159. The `granary` CLI and the local admin socket

Date: 2026-09-28 · Status: accepted

## Context
Operators provision over SSH. Some commands change state that live actors
cache (the allowlist actor holds the allowed set; ops config actors hold
destinations/plans), so writing SQLite behind a running server would leave
caches stale.

## Decision
**Commands** (`src/lib/schemas/cli.ts` pins names and options):

| Command | Needs server? | What |
|---|---|---|
| `granary serve [--data] [--host] [--port]` | – | run the server (loads `<data>/granary.env`, opens socket) |
| `granary init [--data] [--origin] [--yes-i-stored-the-key]` | no (refuses if running) | create data dir (0700), generate + confirm master key, write `granary.env` skeleton |
| `granary doctor` | optional | Bun version, data dir perms, master key present/decodes, `PRAGMA integrity_check` of both DBs, disk free, ORIGIN reachable, GitHub App auth (`GET /app`), socket reachable |
| `granary admin add\|remove <login>` / `admin list` | socket, else direct | in-product admins (ADR 0161) |
| `granary login-link <login> [--ttl 15m]` | socket, else direct | one-time sign-in URL (ADR 0161) |
| `granary github status` | socket | connection mode, app slug, installations, last catch-up |
| `granary github setup-url` | socket | URL of `/settings/github` (+ a login link if `--login`) |
| `granary config get\|set <key> [value]` / `config seed` | socket, else direct | in-product settings by dotted key; `seed` applies env seeds now |
| `granary backup now [--plan]` / `backup list` | socket | ops backups |
| `granary restore …` | no (refuses if running) | the existing ops restore CLI (ADR 0115) |
| `granary version` | no | package + Bun + tinyactors versions |

**Transport:** HTTP/1.1 over a unix socket `<data>/admin.sock` (Bun.serve
`unix:` on the server, `fetch(url, { unix })` in the CLI). The socket file is
0600 and the data dir 0700, so only the service user (and root) can talk to
it; there is no other auth. Requests are `POST /v1/<command>` with a JSON
body; responses are JSON `{ ok: true, result }` or `{ ok: false, error:
{ code, message } }`. Every body is validated with the TypeBox schemas in
`src/lib/schemas/admin-socket.ts` on both ends. The server handles commands
through the same Backend/OpsBackend methods the UI uses (so caches update);
actor `admin-cli` is recorded as the actor in audit fields.

**Offline fallback:** when the socket is absent/refuses **and** no live
server holds `<data>/granary.pid` (pid not alive), `admin *`, `login-link`,
`config *` open `granary.sqlite` directly (safe: no caches running).
Commands marked "socket" fail with a clear message instead. `init` and
`restore` refuse while a server runs.

**Output:** human-readable by default, `--json` prints the raw result.
Exit codes: 0 ok, 1 command error, 2 usage error, 3 server not running
(when required).

## Consequences
The CLI is a thin client; all logic stays in the server's Backend.
