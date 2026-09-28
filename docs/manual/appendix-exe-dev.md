# Appendix: granary on an exe.dev VM

A worked example on [exe.dev](https://exe.dev), which gives you VMs with
persistent disks and an HTTPS proxy in front of them. Nothing in granary
depends on exe.dev; any Linux host with a TLS-terminating proxy works the
same way.

The layout uses two VMs in the same account (an account's VMs all live in
its region, e.g. **FRA** for the EU):

| VM | Role | Proxy |
|---|---|---|
| `granary` | granary on port 3000 | **public**, because GitHub must reach `/webhook` |
| `granary-grafana` | `grafana/otel-lgtm` (optional) | private, reachable only by you and by `granary` |

exe.dev's default image (exeuntu) is Ubuntu 24.04 with systemd, and
you log in as `exedev`.

## 1. The granary VM

```sh
ssh exe.dev new --name granary --disk 25GB
ssh exe.dev share port granary 3000       # the HTTPS proxy targets port 3000
ssh exe.dev share set-public granary      # GitHub must reach https://granary.exe.xyz/webhook
```

exe.dev terminates TLS at `https://granary.exe.xyz/` and adds
`X-Forwarded-Proto` / `X-Forwarded-Host`. Only one port per VM can be
public, and that is granary's.

On the VM (`ssh granary.exe.xyz`), follow [Install](install.md):

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/opt/bun bash
sudo BUN_INSTALL=/opt/bun /opt/bun/bin/bun add -g @tinyactors/granary
sudo ln -sf /opt/bun/bin/bun /opt/bun/bin/granary /usr/local/bin/
sudo useradd --system --home /var/lib/granary --shell /usr/sbin/nologin granary
sudo install -d -o granary -g granary -m 0700 /var/lib/granary
sudo -u granary granary init --data /var/lib/granary --origin https://granary.exe.xyz
#   → store the printed master key in your password manager
sudo sed -i 's/^# PROTOCOL_HEADER/PROTOCOL_HEADER/; s/^# HOST_HEADER/HOST_HEADER/' /var/lib/granary/granary.env
sudo -u granary granary admin add <your-github-login> --data /var/lib/granary
granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service
sudo systemctl daemon-reload && sudo systemctl enable --now granary
sudo -u granary granary login-link <your-github-login> --data /var/lib/granary
```

Open the login link and continue with [First run](first-run.md).

## 2. Grafana on a second, private VM (optional)

```sh
ssh exe.dev new --name granary-grafana --disk 25GB
ssh granary-grafana.exe.xyz 'sudo apt-get install -y docker.io && sudo docker run -d --restart unless-stopped \
  --name lgtm -p 3000:3000 -p 4318:4318 -v lgtm:/data grafana/otel-lgtm'
```

Grafana is at `https://granary-grafana.exe.xyz/` (port 3000, behind exe.dev
login; the image's own login is `admin`/`admin`, so change it). The OTLP
receiver on 4318 is reachable only through exe.dev.

Let the `granary` VM send to it without storing any credential, using a
VM-to-VM integration:

```sh
ssh exe.dev integrations add http-proxy --name grafana-otlp \
  --target https://granary-grafana.exe.xyz:4318/ --peer --attach vm:granary
```

In granary, **Ops → Telemetry → New sink**: endpoint
`http://grafana-otlp.int.exe.xyz`, authentication **exe-peer**, Grafana
link `https://granary-grafana.exe.xyz/explore`. **Test sink**, save.

Alternatively use **exe-vm-token** with a token from
`ssh exe.dev ssh-key generate-api-key --vm=granary-grafana --label=granary-telemetry`
and the endpoint `https://granary-grafana.exe.xyz:4318`. That also works
from outside exe.dev.

## 3. Backups

Follow [Backups](backups.md) with an R2 bucket in the EU jurisdiction. The
VM's disk is persistent, but a local copy is no substitute for an off-site
backup. Uploads to R2 count as egress from exe.dev; traffic between your
two VMs doesn't.

## Sizes

The default 25 GB disk is plenty for granary: a backup needs about one
database's worth of free space, and backups run only while at least 1 GiB
and 10 % of the disk stay free. `ssh exe.dev resize granary --disk=…` grows
it if Ops ever says otherwise.
