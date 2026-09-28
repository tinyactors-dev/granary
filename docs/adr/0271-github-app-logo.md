# 271. A flat logo for GitHub, uploaded by hand

Date: 2026-09-28 · Status: accepted

## Context
The GitHub App needs a logo. The first attempt used the maskable app icon
(`icon-maskable-512.png`): GitHub crops app avatars to a circle and pads them
with the app's badge background colour, so the icon's own gradient square
showed as a visible inner tile. GitHub also rejects webp. The user asked for
the app to register its logo itself on creation.

GitHub offers no way to do that: the app manifest accepts `name`, `url`,
`hook_attributes`, `redirect_url`, `callback_urls`, `setup_url`,
`description`, `public`, `default_events`, `default_permissions`,
`request_oauth_on_install` and `setup_on_update`, with no logo field, and the
REST API has no endpoint to upload or change an app's logo (it's a web-UI-only
setting). The manifest `description` *is* supported and is set.

## Decision
- **`github` brand variant** in `tools/brand/render.ts` (`mise run
  brand:render`): one solid `#1d1710` over the whole canvas (no gradient, no
  rounded tile, no transparency), flat grain fills, the wheat scaled to 0.68
  so its tips reach ~80 % of the inscribed circle's radius. Outputs
  `static/brand/granary-github.svg`, `granary-github-512.png` and
  `granary-github-1024.png` (PNG, opaque, 14 KB / 30 KB). `mise run
  brand:preview-github -- <out.png>` renders it cropped to a circle on GitHub's
  light (#ffffff) and dark (#0d1117) UI at 200–20 px for review.
- **Make the manual step effortless**: `/settings/github` shows an *Add the
  app logo* card (download link served by granary itself, the badge colour
  `#1d1710` with a copy button, and a link to the app's settings page) until an
  admin dismisses it (`Backend.dismissGitHubLogoHint`, audited as
  `github.logo.dismiss`, stored per app id so a new app shows it again). The
  `?created=1` banner points to it.
- **Owner type is recorded** (`github_app.owner_type`, migration 4) from the
  manifest conversion and `GET /app`, so the settings link (and the
  permissions link of ADR 0281) is right for organization apps even before an
  installation exists. Older rows fall back to the installation heuristic.
- Manifest description: "Closes issues and pull requests from people who
  aren't on the allowlist."

## Consequences
Uploading the logo stays a one-time manual step per app, now one click to
download and one to open the right page. If GitHub adds an API for it, the
card can be replaced by an automatic upload.
