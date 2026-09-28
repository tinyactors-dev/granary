# Backups

granary backs up both of its databases (`granary`, `ops`) on a schedule:
a consistent snapshot, compressed (zstd), **always encrypted** (AES-256-GCM,
key wrapped by the master key), streamed to every destination, and
committed by a manifest written last. A restore drill regularly downloads a
backup, decrypts it and checks it. Everything is under **Ops**.

## Cloudflare R2 (recommended)

1. In the Cloudflare dashboard, **R2 → Create bucket**. Choose the
   **EU jurisdiction** if your data must stay in the EU. The jurisdiction
   can't be changed after creation. Don't enable public access.
2. **R2 → Manage API tokens → Create API token**, with permission **Object
   Read & Write**, **applied to this bucket only**. Note the *Access Key
   ID* and *Secret Access Key*, and your *Account ID* (32 hex characters,
   shown on the R2 overview page).
3. In granary: **Ops → Destinations → New → Cloudflare R2**. Enter the
   account ID, jurisdiction (`eu`), bucket, a prefix (default `prod/`),
   the access key ID, and the secret access key (stored encrypted, never
   shown again).
4. Optionally paste the bucket's dashboard URL as **Storage console link**,
   so granary can link to it.
5. **Test connection** writes, reads, lists and deletes a probe object, and
   checks that a manifest can't be overwritten. **Save**. A new destination
   is saved disabled; run **Test connection** once more on the saved
   destination, then switch **Enabled** on and **Save**.
6. **Add it to a plan** (next section). New destinations are not added to
   existing plans automatically.

A token scoped to one bucket can't create or configure buckets, so granary
never does. R2 aborts unfinished multipart uploads after 7 days by default.
Keep that rule.

Other S3-compatible stores work too (**New → S3-compatible**: endpoint,
region, bucket, keys), as does a local directory. A local copy on the same
disk is fast to restore from but is not a backup.

## Plans

**Ops → Plans** decides what is backed up where and how often. On first
start granary creates a **Local copy (same disk)** destination and an
**All databases** plan: both databases every hour to the local copy, with
a restore drill per destination every week. Edit the plan and tick your
off-site destination. Until you do, Ops reports *No off-site backup
destination*. **Back up now** runs a plan immediately,
as does `granary backup now` on the server.

A backup runs only if the disk has room: free space minus the database size
must stay above 1 GiB and 10 % of the disk. Otherwise it is postponed and
reported.

## Retention

Per destination (defaults, editable):

| Keep | Default |
|---|---|
| every backup for | 48 hours |
| one per day for | 14 days |
| one per week for | 8 weeks |
| one per month for | 12 months |
| always the newest | 3 verified backups |

Hard caps bound the total at **82 backups per database** and **8 GiB**, just
under R2's 10 GB free tier. When a cap would be exceeded, the oldest tier is
pruned first. The destination page shows a dry run of what would be deleted
and the projected storage. There is no archive tier: backups exist for
operational continuity.

## Budgets

R2 uploads leave your host and count as egress. The default budget is
**20 GiB per month** (**Ops → Settings**). If the next backup would exceed
it, granary stretches the backup interval (up to 6 hours) instead of
failing.

## When something goes wrong

Nothing pages you. granary retries uploads, cleans up, stretches intervals
and re-runs drills by itself. What it can't fix shows as a calm *needs you*
item on **Ops** and as a "while you were away" banner in the admin UI, and
it is exported to Grafana (see [Telemetry](telemetry.md)).

Next: [Restore](restore.md).
