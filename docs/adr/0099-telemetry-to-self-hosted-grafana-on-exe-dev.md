# 99. Telemetry to self-hosted Grafana on an exe.dev VM

Date: 2026-09-28 · Status: proposed · Partially superseded by 107 (volume control) · Partially supersedes 85 (sink targets and auth)

## Context — exe.dev facts (retrieved 2026-09-28)
- HTTP proxy (<https://exe.dev/docs/proxy.md>): `https://vmname.exe.xyz/`
  with TLS terminated by exe.dev; **private by default** ("only users with
  access to the VM can access the HTTP proxy … redirected to log into
  exe.dev"); "The proxy transparently forwards ports between 3000 and 9999"
  as `https://vmname.exe.xyz:<port>/`; only one port can be public.
- VM HTTPS tokens (<https://exe.dev/docs/https-tokens-for-vms.md>): `ssh
  exe.dev ssh-key generate-api-key --vm=<vm> --label=<label>`; send as
  `X-Exedev-Authorization: Bearer <token>` (preferred; stripped by the
  proxy), `Authorization: Bearer` (deprecated) or Basic (password = token).
- VM-to-VM peer integration (<https://exe.dev/docs/integrations-vm-to-vm.md>):
  `integrations add http-proxy --name <n> --target https://<vm>.exe.xyz:<port>/ --peer --attach vm:<source>`;
  the source VM calls `http://<n>.int.exe.xyz/…`; "exe.dev generates an API
  key scoped to the target VM, stores it server-side, and injects it at the
  network edge" — **the source VM never holds a credential**; requests arrive
  with an unforgeable `X-Exedev-Source-Vm`.
- VMs boot from container images (`new --image`, proxy port picked from
  `EXPOSE`, <https://exe.dev/docs/cli-new.md>, <https://exe.dev/docs/proxy.md>).

## Decision
- **Grafana VM**: a separate exe.dev VM (e.g. `granary-grafana`) running
  `grafana/otel-lgtm` (Grafana + Loki + Tempo + Prometheus, OTLP receiver on
  4317/4318; spike-verified in ADR 0085). Proxy port **3000** (Grafana UI,
  private — the user reaches it through exe.dev login); OTLP/HTTP on
  **4318** (forwarded, private). Nothing is public. Loki/Tempo/Prometheus
  retention on that VM set to fit its disk (e.g. 14 d logs, 7 d traces, 30 d
  metrics) — part of the setup doc, not ops code.
- **Transport**: OTLP/HTTP protobuf only (the `loki-push` sink kind is
  dropped from the first version; otel-lgtm ingests logs via OTLP).
- **Two supported auth modes** for the `otlp-http` sink:
  1. **`exe-peer` (recommended in production)**: endpoint
     `https://grafana-otlp.int.exe.xyz` (plain `http://` answers 301 — verified 2026-09-28) (a peer integration targeting
     `https://granary-grafana.exe.xyz:4318/`, attached to the granary VM).
     **granary stores no credential at all**; the test connection only checks
     reachability and a 200 on an empty OTLP request.
  2. **`exe-vm-token`**: endpoint `https://granary-grafana.exe.xyz:4318`,
     secret = a VM token sent as `X-Exedev-Authorization: Bearer …`. Used from
     outside exe.dev (laptop/dev, staging elsewhere) and as a fallback.
  Generic modes (`none`, `bearer`, `basic`, `header`) remain for non-exe.dev
  setups and for fake-infra.
- The UI's telemetry page shows copy-paste setup commands for both modes and
  a deep link to Grafana Explore (`https://granary-grafana.exe.xyz/explore`)
  pre-filled with `{service_name="granary"}`.
- **Volume control** (Grafana VM disk + egress budget, ADR 0098): granary
  traces are exported with `sample` ratio (default 1.0, auto-lowered to keep
  under the telemetry egress budget; errors and lifecycle spans are always
  kept by tinyactors), logs are rate-limited per definition (existing
  `logLimit`), metrics every 60 s.
- Everything else from ADR 0085 stands: batching, bounded buffer, drop-oldest
  with counters, circuit, `Retry-After`, fan-out owned by ops, loop breaking
  (ADR 0093).

## Consequences
In production the telemetry path has no secret to leak or rotate. The
exe.dev proxy's behaviour for large protobuf POSTs and its latency are
verified by the real-infra contract test (ADR 0103).
