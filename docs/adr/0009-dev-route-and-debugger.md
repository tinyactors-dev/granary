# 9. The /__dev route and the debugger

Date: 2026-09-28 · Status: accepted · Partially superseded by 290

## Decision
When dev mode is on (ADR 5), `/__dev` offers:
- **Log in as** any login (creates a session directly, no OAuth), including
  a one-click "admin".
- **Trigger actions** on the fake GitHub: open an issue as a user (with
  association), reopen, redeliver a delivery, inject REST faults, reset.
- **Debugger:** the app runs a DAP TCP server on `127.0.0.1:$DAP_PORT`
  using `createDebugSession` + `DAPReader`/`encodeDAPMessage`, granting
  `send`, `set`, `goto`, `evaluate`. `/__dev` lists resident actors
  (`system.actors()`) with their active states, and for each shows a
  ready-to-paste VS Code `launch.json` attach configuration
  (`{"type":"tinyactors","request":"attach","port":4711,"address":"issue/…"}`)
  and a "send event" form.
- A live span feed from the app's own trace sink (last 200 decoded spans,
  kept in memory in dev only).

Every `/__dev` request and remote function re-checks dev mode server-side
and returns 404 otherwise.
