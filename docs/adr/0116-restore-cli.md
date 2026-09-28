# 116. `mise run ops:restore`: restore with only 1Password and bucket credentials

Date: 2026-09-28 · Status: accepted

## Decision
`src/lib/ops/cli/restore.ts` (mise task `ops:restore`), run under
`fnox exec -P prod --` so `OPS_MASTER_KEY` (and `_PREVIOUS`) are present:
- **config mode** `--ops-db data/ops.sqlite --dest <id>`: destination and
  credential come from ops.sqlite (secret decrypted with the master key);
- **direct mode** (the VM is gone): `--r2-account <id> [--jurisdiction eu]`
  or `--endpoint URL`, `--bucket`, `--prefix`, `--access-key-id`, secret in
  `OPS_RESTORE_SECRET_ACCESS_KEY`.
`--list` lists committed backups; `--database`, `--run <id>` or `--latest`
select one; `--out` (refuses to overwrite without `--force`); `--json`.
The file is written as `.partial`, verified (three sha256s, integrity_check,
row counts vs. manifest) and only then renamed. Exit 0 = verified restore,
1 = usage, 2 = restore failed (reason = the drill result vocabulary).
