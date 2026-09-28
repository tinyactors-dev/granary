# Restore

`granary restore` downloads a backup, decrypts it, verifies it (checksums,
`PRAGMA integrity_check`, row counts against the manifest) and writes a
SQLite file. It exits 0 only when every check passes. It refuses to run
while granary is running and never overwrites a file without `--force`.

## Restoring on the same host

The data directory still has `ops.sqlite`, so granary knows the
destinations and their credentials:

```sh
sudo systemctl stop granary
sudo -u granary granary restore --data /var/lib/granary --list --dest <destination-id>
sudo -u granary granary restore --data /var/lib/granary \
  --dest <destination-id> --database granary --latest --out /var/lib/granary/restored.sqlite
# check it, then swap it in:
sudo -u granary mv /var/lib/granary/granary.sqlite /var/lib/granary/granary.sqlite.broken
sudo -u granary rm -f /var/lib/granary/granary.sqlite-wal /var/lib/granary/granary.sqlite-shm
sudo -u granary mv /var/lib/granary/restored.sqlite /var/lib/granary/granary.sqlite
sudo systemctl start granary
```

Destination ids are shown under **Ops → Destinations** (`--run <runId>`
restores a specific run instead of `--latest`). Repeat with
`--database ops` for the ops database.

## Disaster recovery on a new host

You need only two things: the **master key** (from your password manager)
and **bucket credentials** (an R2 token with read access).

```sh
bun add -g @tinyactors/granary
export GRANARY_MASTER_KEY=<the key from your password manager>
export GRANARY_RESTORE_SECRET_ACCESS_KEY=<secret access key>
granary restore --r2-account <account-id> --jurisdiction eu --bucket <bucket> \
  --prefix granary/ --access-key-id <access-key-id> --list
granary restore --r2-account <account-id> --jurisdiction eu --bucket <bucket> \
  --prefix granary/ --access-key-id <access-key-id> --database granary --latest --out granary.sqlite
granary restore … --database ops --latest --out ops.sqlite
```

For another S3-compatible store use `--endpoint https://… [--region …]`
instead of `--r2-account`. Then set up the host as in [Install](install.md),
but instead of `granary init` put the restored `granary.sqlite` and
`ops.sqlite` into the data directory and provide the same master key (as
`GRANARY_MASTER_KEY` in `granary.env`, or written to `master.key` with mode
0600). Everything configured in the product comes back with the databases:
the GitHub App, admins, allowlist, destinations and telemetry.

If you rotated the master key, older backups need the previous key:
set `GRANARY_MASTER_KEY_PREVIOUS` as well.

Webhooks GitHub couldn't deliver while you were down are re-sent by the
missed-webhook catch-up, if the outage was shorter than 72 hours. For longer
outages, redeliver them from the app's **Advanced** tab on GitHub.
