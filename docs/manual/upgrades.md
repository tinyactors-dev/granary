# Upgrades

## Release channels

| Channel | Install | For |
|---|---|---|
| stable (`latest`) | `bun add -g @tinyactors/granary` | production |
| frequent builds (`dev`) | `bun add -g @tinyactors/granary@dev` | trying changes early |

(With the system-wide install from [Install](install.md), run these as
`sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g …`.)

Versions follow semver (`0.x` while the product is young: minor versions
may change behaviour; read `CHANGELOG.md` in the package). Dev builds are
versioned like `0.1.0-dev.<unix-epoch>.g<commit>`, and `/healthz` and
`granary version` report the exact build.

## `mise run deploy`

From a checkout of the repository, `mise run deploy` upgrades a host that was
installed the documented way (Bun under `/opt/bun`, unit `granary.service`,
data in `/var/lib/granary`, passwordless `sudo` for your SSH user):

```sh
mise run deploy -- --host granary.example.com --dry-run   # preflight + plan, changes nothing
mise run deploy -- --host granary.example.com             # pack HEAD (dev channel) and deploy it
mise run deploy -- --host … --channel latest              # pack HEAD for the latest channel
mise run deploy -- --host … --tarball release/tinyactors-granary-<version>.tgz   # an existing build
mise run deploy -- --host … --npm @dev                    # from the registry: a dist-tag …
mise run deploy -- --host … --npm 0.1.0                   # … or an exact version
```

It:

1. checks the host over SSH (Bun, `granary`, the unit, `granary.env`,
   `sudo -n`) and reads `ORIGIN`, `HOST`/`PORT` and the running version;
2. packs `HEAD` (the working tree must be clean; it deploys commits, not
   edits) unless `--tarball` or `--npm` is given;
3. copies the tarball to `/tmp/<versioned name>` and runs
   `bun add -g --force` (a versioned name, because Bun's install cache would
   otherwise reuse an older tarball at the same path), then removes it;
4. restarts `granary.service` and waits (`--timeout`, default 60 s) until
   `/healthz` reports the new version on the host **and** at `ORIGIN`;
5. prints `/readyz`.

Other options: `--data`, `--bun-install`, `--service` for non-default layouts.
It exits non-zero at the first failed step and says which.

Take a fresh backup first if the release changes the database
(`sudo -u granary granary backup now --data /var/lib/granary`); see
*Rolling back* below.

## Upgrading by hand

```sh
sudo -u granary granary backup now --data /var/lib/granary     # a fresh backup to roll back to
sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g --force @tinyactors/granary@latest
#   (or a tarball: copy it under its versioned name, then add -g --force /tmp/<that name>)
sudo systemctl restart granary
granary version
curl -s localhost:3000/healthz            # reports the new version
sudo -u granary granary doctor --data /var/lib/granary
```

Database migrations run automatically at startup, in one transaction each,
and only forward. The restart is a short outage. Webhooks GitHub couldn't
deliver meanwhile are re-sent by the missed-webhook catch-up.

If Bun or the package moved to a different path, regenerate the unit:
`granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service`.

## Rolling back

Deploy the previous build: `mise run deploy -- --host … --tarball
release/tinyactors-granary-<previous>.tgz` (keep old tarballs from
`release/`), or `--npm <previous-version>` once releases are on npm.

Migrations don't run backwards, so an older version may refuse a newer
database. If it does:

1. `sudo systemctl stop granary`
2. install the previous version (as above, without starting it)
3. restore the backup you took before the upgrade ([Restore](restore.md))
4. `sudo systemctl start granary`
