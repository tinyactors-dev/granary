# 232. The CLI never writes to an unexpected data dir

Date: 2026-09-28 · Status: accepted

## Context
On ta-granary (data dir `/var/lib/granary`, owned by `granary`, mode 0700,
run by systemd) the admin ran `granary login-link dhamidi` as `exedev`,
without `--data`. The CLI resolved the per-user default
(`~/.local/state/granary`), found no server there, created a brand-new empty
`granary.sqlite`, wrote the token into it and printed
`http://localhost:3000/auth/link/…`. The link could never work. An admin CLI
that silently writes somewhere else is worse than one that fails.

## Decision
1. **Resolution:** `--data` > `GRANARY_DATA_DIR` > `/var/lib/granary` when it
   exists > `$XDG_STATE_HOME/granary` / `~/.local/state/granary`. The system
   dir (the documented deployment) beats the per-user default, so an admin on
   a server lands on the real dir. `init` follows the same order (no special
   default); pass `--data` for clarity. `GRANARY_TEST_SYSTEM_DATA_DIR` stands
   in for `/var/lib/granary` in tests.
2. **Only `init` and `serve` create state.** Every other command that uses a
   data dir (admin, login-link, config, github, backup, doctor, restore in
   config mode) first requires it to exist, be initialised (`granary.env`,
   `master.key` or `granary.sqlite` present) and be readable, writable and
   searchable by the current user. Otherwise it exits **4**
   (`EXIT.dataDir`) naming the path and how it was chosen, and writes
   nothing. `version`, `systemd-unit` and `restore` in direct
   (disaster-recovery) mode need no data dir.
3. **Permissions:** an inaccessible data dir fails with the owner (from
   `stat`, resolved via `/etc/passwd` or `id -nu`) and a copyable
   `sudo -u <owner> granary <same arguments>` line; no fallback. The admin
   socket stays owner-only (0600): `sudo -u granary` is the one supported way
   to administer a system install. An admin group was considered and
   rejected — more moving parts for no gain on a single-purpose host.
4. **Links need ORIGIN:** `login-link` (offline, over the socket, and from
   the UI) and `github setup-url` refuse when `ORIGIN` is unset instead of
   printing a localhost URL. Offline, ORIGIN comes from `<data>/granary.env`.
5. The direct-write note names the data dir it wrote to.

## Consequences
Running the CLI as the wrong user or against the wrong dir is loud and
harmless. The manual (install, first run, troubleshooting, exe.dev appendix,
CLI reference) shows `sudo -u granary granary …` everywhere.
