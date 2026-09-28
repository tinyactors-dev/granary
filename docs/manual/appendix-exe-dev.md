# Appendix: granary on an exe.dev VM

A worked example on [exe.dev](https://exe.dev), which gives you VMs with
persistent disks and an HTTPS proxy in front of them. Nothing in granary
depends on exe.dev; any Linux host with a TLS-terminating proxy works the
same way. This is how the tinyactors instance runs (ADR 0231 has its real
names: `ta-granary`, `ta-metrics`, `granary.tinyactors.dev`); below the VMs
are called `granary` and `metrics`.

| VM | Role | Proxy |
|---|---|---|
| `metrics` | `grafana/otel-lgtm`, shared by all your services | **private**: only you, and VMs through an integration |
| `granary` | granary on port 3000 | **public**, because GitHub must reach `/webhook` |

An account's VMs live in its region (`ssh exe.dev whoami`; **fra** is the
EU). exe.dev's default image (exeuntu) is Ubuntu 24.04 with systemd and
Docker; you log in as `exedev`, which has passwordless `sudo`.

Quote `ssh exe.dev` commands that contain spaces: the remote side splits
the command line again (`ssh exe.dev "new --comment='two words'"`).

## 1. Create the VMs

```sh
ssh exe.dev "new --name=metrics --disk=30GB --tag=services --comment='Shared observability' --no-email"
ssh exe.dev "new --name=granary --disk=25GB --tag=services --no-email"
```

The tag (`services` here, `tinyactors` for us) is what lets every VM of the
group send telemetry to `metrics` (step 2).

## 2. A shared observability VM

```sh
ssh metrics.exe.xyz 'sudo install -d -m 0755 /var/lib/observability && sudo docker run -d \
  --restart unless-stopped --name lgtm \
  -p 3000:3000 -p 4317:4317 -p 4318:4318 \
  -v /var/lib/observability:/data \
  -e GF_SERVER_ROOT_URL=https://metrics.exe.xyz/ \
  -e GF_AUTH_ANONYMOUS_ENABLED=false \
  -e GF_AUTH_PROXY_ENABLED=true \
  -e GF_AUTH_PROXY_HEADER_NAME=X-ExeDev-Email \
  -e GF_AUTH_PROXY_HEADER_PROPERTY=email \
  -e GF_AUTH_PROXY_AUTO_SIGN_UP=true \
  -e GF_USERS_AUTO_ASSIGN_ORG_ROLE=Admin \
  -e GF_AUTH_DISABLE_LOGIN_FORM=true \
  grafana/otel-lgtm:latest'
ssh exe.dev share port metrics 3000     # Grafana; the VM stays PRIVATE
ssh exe.dev "integrations add http-proxy --name=metrics-otlp --target=https://metrics.exe.xyz:4318/ --peer --attach=tag:services"
```

- Grafana is at `https://metrics.exe.xyz/`. exe.dev makes you log in and
  passes your email as `X-ExeDev-Email`; Grafana signs you in with it (auth
  proxy), so there is no Grafana password. This is safe **only while the VM
  is private**: exe.dev strips and sets that header, but after
  `share set-public` anyone could send it. Never make this VM public.
- `metrics-otlp` is a VM-to-VM (peer) integration: VMs tagged `services`
  send OTLP to **`https://metrics-otlp.int.exe.xyz`** without holding any
  credential; exe.dev injects the key at its edge, and the receiver sees the
  caller as `X-Exedev-Source-Vm`. Use `https://` (plain `http://` answers
  `301`).
- Another service joins by tagging its VM (`ssh exe.dev tag <vm> services`)
  and exporting OTLP/HTTP to that endpoint with its own `service.name`.

Check from a tagged VM: `curl -s -o /dev/null -w '%{http_code}\n' -X POST
https://metrics-otlp.int.exe.xyz/v1/traces -H 'content-type: application/json' -d '{}'`
prints `200`.

## 3. The granary VM

```sh
ssh exe.dev share port granary 3000       # the HTTPS proxy targets port 3000
ssh exe.dev share set-public granary      # GitHub must reach /webhook
```

exe.dev terminates TLS and adds `X-Forwarded-Proto` / `X-Forwarded-Host`.
Only one port per VM can be public, and that is granary's.

On the VM (`ssh granary.exe.xyz`), follow [Install](install.md): Bun under
`/opt/bun`, the package (from npm, or a tarball before the first release),
the `granary` user and `/var/lib/granary`. For the master key, either let
`granary init` print it once, or put a key you generated into
`/var/lib/granary/master.key` first ([Install §4](install.md#without-ever-printing-the-key)).

```sh
sudo -u granary granary init --data /var/lib/granary --origin https://granary.example.com
sudo sed -i 's/^# PROTOCOL_HEADER/PROTOCOL_HEADER/; s/^# HOST_HEADER/HOST_HEADER/' /var/lib/granary/granary.env
sudo tee -a /var/lib/granary/granary.env >/dev/null <<'EOF'
GRANARY_SEED_OTLP_ENDPOINT=https://metrics-otlp.int.exe.xyz
GRANARY_SEED_OTLP_AUTH=exe-peer
GRANARY_SEED_OTLP_GRAFANA_URL=https://metrics.exe.xyz/explore
EOF
sudo -u granary granary admin add <your-github-login> --data /var/lib/granary
granary systemd-unit --data /var/lib/granary | sudo tee /etc/systemd/system/granary.service
sudo systemctl daemon-reload && sudo systemctl enable --now granary
```

Always run `granary` as the service user (`sudo -u granary granary …`): as
`exedev` the CLI can't read `/var/lib/granary` and refuses with a `sudo -u
granary` hint (exit 4) instead of working on some other directory.

## 4. Your own hostname (before the GitHub App)

To use e.g. `granary.example.com` instead of `granary.exe.xyz`
([Install §7](install.md#7-settle-the-public-hostname-before-the-github-app)):

1. At your DNS provider: `CNAME granary → granary.exe.xyz`. On Cloudflare,
   **DNS only (grey cloud)**; exe.dev issues the certificate itself.
2. `ssh exe.dev domain add granary granary.example.com` (once the CNAME
   resolves; until then exe.dev answers the name with `421`). The Let's
   Encrypt certificate follows within seconds.
3. `sudo sed -i 's#^ORIGIN=.*#ORIGIN=https://granary.example.com#' /var/lib/granary/granary.env && sudo systemctl restart granary`

`granary.exe.xyz` keeps answering, but sign in and use only the new name.

## 5. First sign-in and the GitHub App

```sh
ssh granary.exe.xyz sudo -u granary granary login-link <your-github-login> --ttl 30m --data /var/lib/granary
```

Open the link, click **Continue**, and follow [First run](first-run.md) from
**Settings → GitHub**.

## 6. Upgrades

From a checkout: `mise run deploy -- --host granary.exe.xyz` (see
[Upgrades](upgrades.md#mise-run-deploy)). It needs nothing beyond the SSH
access and passwordless `sudo` you already have.

## 7. Backups

Follow [Backups](backups.md) with an R2 bucket in the EU jurisdiction. The
VM's disk is persistent, but a local copy is no substitute for an off-site
backup. Uploads to R2 count as egress from exe.dev; traffic between your
VMs doesn't.

## Sizes

The default 25 GB disk is plenty for granary: a backup needs about one
database's worth of free space, and backups run only while at least 1 GiB
and 10 % of the disk stay free. `ssh exe.dev resize granary --disk=…` grows
it if Ops ever says otherwise. The observability VM's disk grows with
retention; 30 GB is a comfortable start.
