# 181. release:verify installs the tarball on clean Linux containers

Date: 2026-09-28 · Status: accepted · Partially superseded by 230

## Context
ADR 0156 requires the packed tarball to be exercised on clean linux-x64 and
linux-arm64 hosts before publishing. Development happens on Apple silicon
with docker via colima.

## Decision
- `mise run release:verify` (`tools/release/verify.ts`) runs, per platform in
  `RELEASE_DEFAULTS.platforms` (`linux/arm64`, `linux/amd64`), the image
  `oven/bun:<minimum supported Bun>` as a **pitchfork daemon**
  (`granary-verify-<arch>`) through `tools/dev/container.sh` with the same
  exact container name; afterwards it stops the daemon and removes that exact
  container (`docker rm -f granary-verify-<arch>`), since a stop signal does
  not always reach the container through the wrapper.
- Inside (`tools/release/verify-inside.ts`): `bun add -g` the tarball, load the
  native addon and create a system, `granary version`, `granary init --yes`,
  `granary serve` (fallback: `bun build/index.js` when the CLI is a
  placeholder), `GET /healthz` and `/readyz`, `granary doctor`, SIGTERM and a
  clean exit. Results go to `release/verify/<arch>/out/result.json` and the
  summary to `release/verify.json` (tarball sha256 + git sha).
- A step is **missing** (not failed) when the feature isn't in the build yet
  (CLI placeholder, 404 on `/healthz`). Exit codes: 0 all ok, 2 only missing
  and `--allow-missing`, 1 otherwise. Publishing requires a fully passing run
  for every platform.
- **Emulated amd64:** qemu under colima has no AVX and the default Bun build
  crashes ("CPU lacks AVX support"). When the target is amd64 and the docker
  host is not, verify mounts Bun's official **baseline** build of the same
  version over `/usr/local/bin/bun`. Real x86-64 hosts have AVX and use the
  normal build; this only affects the verification environment.

## Consequences
One command proves a tarball installs and runs on a fresh host for both
architectures. amd64 runs under emulation are slow (minutes).
