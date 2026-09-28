# 106. EU region: exe.dev FRA for both VMs, R2 bucket in the EU jurisdiction

Date: 2026-09-28 · Status: proposed · Partially supersedes 95 (endpoint derivation)

## Context
The user wants both exe.dev VMs (granary, granary-grafana) in the **EU**.
- exe.dev regions (<https://exe.dev/docs/regions.md>): PDX, LAX, NYC, DAL,
  **FRA** (Frankfurt, Germany), TYO, SYD, SGP, **LON** (London, UK). "Each
  account is associated with a region. All of that account's VMs are hosted in
  that region." LON is not in the EU → **FRA**. (The account's region is set
  with `ssh exe.dev set-region`, <https://exe.dev/docs/cli-set-region.md>.)
- R2 data location (<https://developers.cloudflare.com/r2/reference/data-location/>):
  location hints (`wnam, enam, weur, eeur, apac, oc`) are "a best effort and
  not a guarantee"; jurisdictions (`eu`, `fedramp`, `us`) "guarantee objects in
  a bucket are stored within a specific jurisdiction"; EU jurisdiction buckets
  use the S3 endpoint `https://<account_id>.eu.r2.cloudflarestorage.com`;
  "Once an R2 bucket is created, the jurisdiction cannot be changed."

## Decision
- Both VMs in exe.dev **FRA**.
- The R2 bucket is created in the **EU jurisdiction** (not merely with a
  `weur` hint): the backups contain personal data (GitHub logins, session
  ids), the guarantee costs nothing extra, and FRA → EU R2 keeps latency
  low. A hint gives no guarantee and the jurisdiction can't be added later, so
  it must be right at creation.
- The `r2` destination kind gets a required `jurisdiction: 'default' | 'eu' |
  'fedramp'` (default `eu` in the UI and seeds); endpoint derivation:
  `default` → `https://<account>.r2.cloudflarestorage.com`,
  `eu` → `https://<account>.eu.r2.cloudflarestorage.com`,
  `fedramp` → `https://<account>.fedramp.r2.cloudflarestorage.com`
  (fedramp endpoint to be verified before use; not needed here). Region stays
  `auto`.
- Setup doc: create the bucket with jurisdiction *European Union*
  (dashboard or `wrangler r2 bucket create <name> --jurisdiction eu`), and
  create the Object Read & Write token for that bucket; the contract test
  confirms the token works against the `.eu.` endpoint (Cloudflare shows
  jurisdiction-specific S3 endpoints for such buckets).
- Seed: `OPS_SEED_R2_JURISDICTION` (default `eu`).

## Consequences
A mistake in bucket creation (wrong jurisdiction) means a new bucket; the
test connection shows the derived endpoint so the mismatch is obvious.
