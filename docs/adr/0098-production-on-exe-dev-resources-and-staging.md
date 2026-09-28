# 98. Production on an exe.dev VM: resource facts, thresholds, backup staging

Date: 2026-09-28 · Status: proposed · Partially superseded by 107 (egress budget) · Partially supersedes 83 (space precondition, sealing into spool)

## Context — what exe.dev's docs say (retrieved 2026-09-28)
- **Persistent disk**: "virtual machines, with persistent disks"
  (<https://exe.dev/docs/what-is-exe.md>); "Run a database on it … Use
  sqlite" (<https://exe.dev/docs/serverful.md>); "(exe.dev disks are
  persisted and backed up.)" (<https://exe.dev/docs/guts.md>) — **no RPO,
  retention or restore procedure is documented**, so we do not rely on it.
- **Disk size**: "exe.dev VMs default to having 25 GB of disk, but both new
  and resize accept --disk arguments. Disk is measured according to the ext4
  filesystem usage." (<https://exe.dev/pricing>); resize "must be larger than
  current size" (<https://exe.dev/docs/cli-resize.md>) — disks only grow;
  the default image "is about 4 GB" and exe.dev "occasionally run[s] fstrim"
  (<https://exe.dev/docs/faq/disk-usage.md>).
- **Pooled allowances**: plans give a shared pool, e.g. Small "2 vCPU · 8 GB
  RAM" (<https://exe.dev/docs/billing/overview.md>); pricing lists "100 GB
  pooled disk" and "200 GB"/"250 GB data transfer", "additional disk
  $0.08/GB/month", "additional data transfer $0.05/GB/month"
  (<https://exe.dev/pricing>). **Outbound** traffic "that leaves exe.dev's
  infra" is billed beyond the allowance; "Inbound traffic is never billed"
  (<https://exe.dev/docs/billing/usage.md>).
- **Memory**: "our systems limit the amount of active memory you can use …
  exe.dev infrastructure co-operates with the virtual machine guest kernel to
  shrink its memory" (<https://exe.dev/pricing>). The per-VM default memory is
  **not documented** (`new --memory`, `--cpu` default 2,
  <https://exe.dev/docs/cli-new.md>).
- **Snapshots**: no snapshot command is documented; `cp` copies a whole VM
  (<https://exe.dev/docs/cli-cp.md>). Not a backup mechanism for us.
- **Networking**: no public IP; HTTPS terminated by exe.dev's proxy, ports
  3000–9999 forwarded, one port may be public
  (<https://exe.dev/docs/proxy.md>, <https://exe.dev/docs/faq/how-exedev-works.md>).
  → granary's port must be the public one (GitHub webhooks).

Ambiguities → conservative defaults: unknown memory (read it at runtime),
undocumented platform backups (ignore), whether VM→VM traffic via
`*.int.exe.xyz` counts as outbound (assume it does).

## Decision
- **Thresholds are relative to what the VM reports at runtime**, not
  hard-coded: disk total/free from `fs.statfs(dataDir)`, memory from
  `os.totalmem()` / cgroup `memory.max` when present. Defaults assume the
  25 GB disk.
- **Staging without a second full copy**: the snapshot Worker runs
  `VACUUM INTO <spool>/<run>.sqlite.partial` (≈ 1× DB size, ADR 0083) and
  then **streams** zstd → AES-256-GCM **directly into the multipart upload**
  (`S3File.writer({partSize, queueSize})`), hashing on the way. The sealed
  artifact is never materialised on disk (supersedes "sealed copy in the
  spool"). The raw snapshot is deleted as soon as all destinations have it
  (or the run gives up). Consequence: a retried upload re-seals from the raw
  snapshot (fresh DEK → new artifact, same runId key; fine because the
  manifest is written last).
- **Disk budget** (defaults, editable): a backup starts only if
  `free − dbSize ≥ max(1 GiB, 10 % of disk)`; otherwise ops self-heals in
  order (ADR 0101): delete spool leftovers → drop the local copy →
  `PRAGMA wal_checkpoint(TRUNCATE)` → postpone this run and record an
  *attention* item. Attention thresholds: free < 20 % of disk, or free <
  2 × DB size. (With 25 GB, ~4 GB image and a DB of a few hundred MB, this
  leaves wide margins; the attention item suggests `ssh exe.dev resize
  <vm> --disk=…`.)
- **Local copy**: `local-dir` keeps at most **1** backup, and only while free
  space after it stays ≥ 30 % of disk; it exists for fast restores, not
  safety (same disk as the DB).
- **Memory**: the pipeline is streaming (bounded to ~2 × partSize × queueSize
  ≈ 64 MiB); `serialize()` is never used. Attention when RSS > 60 % of
  available memory for 15 min.
- **Egress budget**: uploads to R2 leave exe.dev and count as outbound.
  Default budget 20 GiB/month for backups (≈ 10 % of the Small plan's
  allowance) and 5 GiB/month for telemetry. Ops projects monthly egress
  from sealed sizes × schedule; if the backup projection exceeds the budget
  it **stretches the hourly tier automatically** (interval =
  `ceil(monthlyBytes / budget)` hours, max 6 h) and records that as an
  *info* item — never exceeding the budget silently, never paging. Restore
  drills download from R2 = inbound = free.
- **Placement on the VM**: `dataDir` (granary.sqlite, ops.sqlite, spool) on
  the VM's persistent disk; granary is the public proxy port; Grafana lives on
  its own VM (ADR 0099) so telemetry storage never competes with the DB's
  disk.

## Consequences
Backups need ~1× DB size of free space instead of ~2.2×. Egress and disk
cost stay predictable on a small plan.
