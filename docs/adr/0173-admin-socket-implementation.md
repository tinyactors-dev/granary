# 173. Admin socket: limits and failure behaviour

Date: 2026-09-28 · Status: accepted · Implements 0159

## Decision
- The server starts the socket in `bootBackend` after the Backend exists, and
  writes `<data>/granary.pid`; both are removed on graceful shutdown.
- Unix socket paths are limited (~104 bytes on macOS, 108 on Linux). If
  `<data>/admin.sock` exceeds 100 bytes the socket is **disabled with a
  warning** (the server still runs; the CLI then reports it unreachable).
  `/var/lib/granary` is far below the limit.
- A stale socket file is replaced; the data dir is tightened to 0700 if it is
  more permissive (logged); the socket is chmod 0600.
- Requests are validated against `ADMIN_COMMANDS`; responses that don't match
  their schema are logged (and rejected by the CLI, which validates too).
  `BackendError`/store errors map to the envelope codes (invalid 400,
  not-found 404, conflict 409, unavailable 503, internal 500).
- `doctor` over the socket adds server-side checks (system, master key as
  loaded, GitHub status, ops status); the CLI merges them over its offline
  checks. `--json` adds `ok` (= status ≠ fail) per check for scripts; check
  names are `bun`, `data-dir`, `master-key`, `database:granary`,
  `database:ops`, `disk`, `origin`, `server`, `system`, `github`, `ops`.
