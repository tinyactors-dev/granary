# 24. agent-browser for interactive verification

Date: 2026-09-28 · Status: accepted

## Context
Agents verifying UI work were installing Playwright and downloading Chromium
per session, which is slow and leaves large ad-hoc installs behind.

## Decision
Interactive browser verification (clicking through pages, filling forms,
taking and inspecting screenshots) uses `agent-browser`, pinned as a tool in
`mise.toml` (`"npm:agent-browser" = "latest"`). Do not install Playwright or
download browsers for this purpose. Automated tests remain HTTP/trace based
(ADR 0007) and do not drive a browser.

## Consequences
One shared, mise-managed browser tool; `mise install` provides it.
