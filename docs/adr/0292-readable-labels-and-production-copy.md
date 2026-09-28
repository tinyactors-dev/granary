# 292. Readable labels everywhere, no tooling talk in production copy

Date: 2026-09-28 · Status: accepted

## Context
The design audit found raw codes in the UI (`not-allowed`, `blocklist.add`,
`snapshotting`, `ack`, `issues.opened`, run and effect keys), lowercase badges
next to sentence-case ones, pages that only said "Issue" although granary now
closes pull requests too, and production pages telling operators to run
`mise run ops:restore`, read keys "from fnox" or size disks for "exe.dev".
ADR 0291 fixed the glossary (item, delivery, decision, action, activity).

## Decision
- **One label source.** `src/lib/components/app/glossary.ts` owns every
  user-facing label: outcomes, kinds (`KindBadge`), decision reasons
  (`blocklist` → "Blocked", `not-allowed` → "Not on the allowlist",
  `association` → "Repository owner, member or collaborator"), action and
  delivery states, deliveries as words (`deliveryLabel`: "Issue opened"),
  backup triggers, telemetry connection states (`SINK_STATE_LABELS`:
  "Healthy", "Retrying", "Paused after errors"). `stateLabel(code)` is the
  default of `StateBadge` and `FilterTabs`: known codes get a label
  (`snapshotting` → "Taking snapshot", `ack` → "Acknowledged",
  `stale` → "Overdue"), unknown codes fall back to sentence case, so a new
  state never shows up as a raw lowercase code.
- **Audit log labels are exhaustive:** `AUDIT_LABELS: Record<AuditAction, …>`
  fails the type check when a new action lacks a label.
- **Internal keys stay out of sight:** run ids, effect keys and delivery
  event codes move into `title` tooltips or `/admin`.
- **Production copy names no tooling or host:** restore instructions use
  `granary restore …`; the master key is "GRANARY_MASTER_KEY or the data
  directory's master key file", rotation happens "in your password manager
  and the service environment"; budgets talk about "the disk size the host
  reports" and "uploads to off-site storage". exe.dev appears only where it
  names a real option (the exe.dev authentication modes of telemetry sinks
  and the matching secret kind) and in the manual's appendix. No ADR numbers
  in rendered text (they stay in code comments and docs). Seed-created
  records get plain names ("Cloudflare R2", "All databases", "Telemetry");
  where they came from is shown by the "From environment" badge.
- **Issues and pull requests** are named together wherever the policy
  applies to both (allowlist, blocklist, wizard permissions, confirm dialogs).
- **Regression guard:** `tests/copy.test.ts` renders every signed-in page
  outside `/admin` (plus an item page and a backup run) and fails on
  "mise run", "fnox", "ADR nnnn" and "exe.dev" (except the two option pages)
  in the visible text; it also checks the item page shows labels, not codes.

## Consequences
New states and audit actions need a label (or accept the sentence-case
fallback). Existing production records keep their seeded names until edited.
