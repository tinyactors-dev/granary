# Actors (main system)

One file per actor: its statechart definition and its data type.
See ADR 0002 for the topology, ADR 0033 for the protocol and ADR 0040 for the
chart details.

- `allowlist.ts` — `allowlist/main`: state `ready`; answers `allowlist.check`
  with `allowlist.verdict` to `event.origin`, `allowlist.replace` swaps the set.
- `issue.ts` — `issue/<repoId>-<number>`: states `restore, idle, checking,
  closing, allowed, closed, failed, settled` (the last four final).
