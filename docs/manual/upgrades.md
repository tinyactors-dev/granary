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
versioned like `0.1.0-dev.<timestamp>.<commit>`.

## Upgrading

```sh
sudo -u granary granary backup now --data /var/lib/granary     # a fresh backup to roll back to
sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g @tinyactors/granary@latest
sudo systemctl restart granary
granary version && granary doctor --data /var/lib/granary
```

Database migrations run automatically at startup, in one transaction each,
and only forward. The restart is a short outage. Webhooks GitHub couldn't
deliver meanwhile are re-sent by the missed-webhook catch-up.

If Bun or the package moved to a different path, regenerate the unit:
`granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service`.

## Rolling back

Migrations don't run backwards, so an older version may refuse a newer
database. To roll back:

1. `sudo systemctl stop granary`
2. `bun add -g @tinyactors/granary@<previous-version>`
3. Restore the backup you took before the upgrade ([Restore](restore.md)).
4. `sudo systemctl start granary`
