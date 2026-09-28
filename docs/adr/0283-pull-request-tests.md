# 283. Pull request scenarios

Date: 2026-09-28 · Status: accepted

`tests/pull-requests.test.ts`, against the running system and the fake:
not-allowed author → closed once with the pull request comment and marker
(trace: `issue` actor ends `closed`); allowlisted → open; draft → closed;
repo pull request switch off → ignored while issues stay gated, on again →
gated; app reduced to issues-only and accepted → status reports missing
access, repos `prAccess: false`, nothing delivered or closed; permissions
granted (pending until accepted) then accepted → `ready`, pull requests
closed.
