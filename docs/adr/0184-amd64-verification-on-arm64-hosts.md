# 184. x86-64 verification needs a native host; emulated runs are skipped

Date: 2026-09-28 · Status: accepted

## Context
release:verify (ADR 0181) should check linux/amd64 and linux/arm64. On the
maintainer's Apple-silicon machine colima runs an aarch64 VM, and amd64
containers run under qemu user emulation. There Bun 1.4.1 fails: the default
build needs AVX ("CPU lacks AVX support", segfault), and even the official
*baseline* build segfaults in `bun add -g` (exit 139), with or without JIT and
with reduced install concurrency. Small scripts run; the installer does not.

## Decision
- On an arm64 docker host, verify **skips** linux/amd64 by default and records
  it as `skipped` with the reason. `--emulated` still tries (baseline Bun is
  mounted), for when a future Bun/qemu combination works.
- verify fails fast when a container ends without a result (and says whether
  it crashed) instead of waiting for the timeout.
- `release:publish` requires a passing run for every platform; a skipped one
  is accepted only with an explicit `--accept-unverified linux/amd64`, and
  it prints a warning.
- Real x86-64 verification happens (a) on any x86-64 machine with docker, or
  (b) in CI with native amd64 + arm64 runners once releases move there
  (ADR 0183), or (c) locally after restarting colima with Rosetta
  (`colima start --vz-rosetta`) — not done automatically because it restarts
  the developer's docker VM and running containers.

## Consequences
Local releases from Apple silicon verify arm64 fully and amd64 only on
request; the published package is the same bytes for both (no native code of
granary's own; `@tinyactors/node` ships per-platform prebuilt addons).
