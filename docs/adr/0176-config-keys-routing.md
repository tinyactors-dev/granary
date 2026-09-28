# 176. `granary config`: where keys live

Date: 2026-09-28 · Status: accepted · Implements 0159

## Decision
- `src/lib/server/config-kv.ts` serves `config get|set` for the socket and the
  CLI's offline mode. Keys owned by the GitHub connection
  (`GITHUB_SETTING_KEYS`, e.g. `github.mode`) are read/written in its
  `github_settings` table (ADR 0190); every other dotted key lives in the
  `settings` kv (`value` JSON, `source seed|cli|ui`).
- `github.mode` is validated (`none|app|token`) and audited as
  `github.mode.set`. Writing a `github.*` key before the GitHub tables exist
  (server never started) fails with a clear message.
- Known gap: a running server's GitHub connection may cache the mode; writing
  it through the socket updates the table but the connection must re-read it
  (GitHub fork / integration).
- CLI values are parsed as JSON when they parse, else taken as strings.
