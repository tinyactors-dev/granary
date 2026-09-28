<img src="https://raw.githubusercontent.com/tinyactors-dev/granary/main/static/brand/granary-128.webp" alt="granary" width="64" height="64">

# granary

Auto-closes GitHub issues opened by people who are not on your allowlist —
durably (SQLite write-ahead log), observably (OpenTelemetry), with encrypted
off-site backups. Runs on [Bun](https://bun.sh).

```sh
bun add -g @tinyactors/granary
granary init --data /var/lib/granary     # prints the master key once — store it!
granary serve --data /var/lib/granary
```

Then open the printed URL, connect GitHub from **Settings → GitHub** (creates a
GitHub App for you) and install it on the repositories to guard.

The full manual ships with the package in `docs/manual/` and lives at
<https://github.com/tinyactors-dev/granary/tree/main/docs/manual>.

License: MIT.
