# 212. Settings UI: what the contract does not cover (yet)

Date: 2026-09-28 · Status: accepted · Fork E5

## Decision
The pinned Backend (ADR 0166) has no method to **list or revoke login
links** and none to **disconnect GitHub**. The UI does not invent them:
- Login links: the page says links are single-use and expire; it offers the
  CLI equivalent (`granary login-link <login> --ttl 15m`).
- Disconnecting: the GitHub page explains to uninstall/delete the app on
  GitHub and run `granary config set github.mode none` on the server
  (ADR 0159 `config set`, key `github.mode` from `GITHUB_SETTING_KEYS`).
- Token mode (`github.mode = token`) is shown read-only as "Token
  connection", configured by seeds/CLI (ADR 0160).

## Consequences
If `listLoginLinks`/`revokeLoginLink` or `disconnectGitHub` are added to the
Backend later, they slot into the existing pages without layout changes.
