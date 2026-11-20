# 302. An `edge` channel: every green push as a GitHub release asset

Date: 2026-11-20 · Status: accepted

Builds on 0301 (every push to main is released to `dev`, hosts pull it).

## Context
npm keeps every new version in an automated review ("Validating") before it
serves it: 0.2.0 waited more than ten minutes, and so does every dev build.
With hosts pulling from npm (0301), a push reached production a quarter of
an hour after CI had finished. The tarball CI publishes is already verified
on amd64 and arm64 by then, and the repository is public.

Whom it serves: the maintainer, who wants a push on the host in minutes.

## Decision
- **The release workflow's `edge` job** (every dev release, i.e. every push
  to main that passes the tests) replaces the rolling GitHub prerelease
  `edge` with the verified tarball and its `SHA256SUMS`, using the
  workflow's own token (`contents: write`). It runs beside the npm publish,
  so npm's state never holds it up. npm `dev` publishing goes on as before.
- **`granary update --channel edge`** (the default) reads `SHA256SUMS` from
  the release's download URL (not the REST API, whose anonymous rate limit a
  one-minute timer would exhaust), takes the version from the tarball's
  name, downloads it, checks the hash, keeps it in
  `/var/cache/granary-update` under its versioned name, and installs it with
  `bun add -g --force <file>`. The last three tarballs are kept, so a
  rollback from an edge build reinstalls the previous file; a version that
  is not cached comes from npm.
- **The timer runs every minute** by default: a run with nothing to do is
  one small HTTP request.

## Consequences
- A green push reaches a host on `edge` in about four minutes (CI's three,
  plus the timer).
- What the host installs is trusted through GitHub (the release is written
  by this repository's workflow) and the hash file, not npm's provenance.
  GitHub's build attestations could be checked too, but that needs `gh` on
  the host; not now.
- The tarball's dependencies (`@tinyactors/node`, typebox) still come from
  npm, at versions already reviewed.
- For a moment while the job replaces it, the release does not exist; the
  updater then does nothing and tries again a minute later.
