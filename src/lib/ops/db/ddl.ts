/**
 * ops.sqlite schema (ADR 0089, 0101, 0109) — pinned in M0 because several
 * agents write to it. The code that opens/migrates the DB (`db/open.ts`) is
 * owned by the backups agent (M1). Pragmas: WAL, synchronous=FULL,
 * foreign_keys=ON. JSON columns are validated with TypeBox on read and write.
 */
import { Type, type Static } from '@sinclair/typebox';

export const OPS_PRAGMAS = ['PRAGMA journal_mode=WAL', 'PRAGMA synchronous=FULL', 'PRAGMA foreign_keys=ON', 'PRAGMA busy_timeout=5000'] as const;

/** Ordered migrations; `PRAGMA user_version` = number applied. Append only. */
export const OPS_MIGRATIONS: readonly string[] = [
	/* 1: config, secrets, audit */ `
CREATE TABLE destinations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('r2','s3','local-dir')),
  name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL CHECK (origin IN ('seed','ui')),
  version INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, -- JSON: {settings, retention, caps}
  last_test_at INTEGER, last_test_ok INTEGER, last_test_version INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE backup_plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, -- JSON: {databases, destinationIds, intervalMs, drillIntervalMs}
  effective_interval_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE telemetry_sinks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, -- JSON: TelemetrySinkConfig minus meta
  last_test_at INTEGER, last_test_ok INTEGER, last_test_version INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE budgets (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  ciphertext BLOB NOT NULL, iv BLOB NOT NULL, wrapped_dek BLOB NOT NULL, kek_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, previous_ciphertext BLOB, previous_iv BLOB, previous_wrapped_dek BLOB, previous_kek_id TEXT,
  previous_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_used_at INTEGER, last_used_ok INTEGER);
CREATE TABLE ops_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, -- login or 'system' or io type
  action TEXT NOT NULL, area TEXT NOT NULL, target_id TEXT, detail TEXT);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`,
	/* 2: runs, uploads, drills */ `
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, database TEXT NOT NULL,
  state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, raw_path TEXT, raw_bytes INTEGER, raw_sha256 TEXT,
  snapshot TEXT, -- JSON RawSnapshot once ready
  sealed_bytes INTEGER, error TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX backup_runs_plan ON backup_runs(plan_id, started_at DESC);
CREATE INDEX backup_runs_state ON backup_runs(state);
CREATE TABLE uploads (
  run_id TEXT NOT NULL REFERENCES backup_runs(id), destination_id TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  artifact_key TEXT, manifest TEXT, -- JSON BackupManifest once sealed
  uploaded_bytes INTEGER NOT NULL DEFAULT 0, last_error TEXT, -- JSON StoreError
  updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, destination_id));
CREATE INDEX uploads_state ON uploads(state, next_attempt_at);
CREATE TABLE restore_drills (
  id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, database TEXT NOT NULL, run_id TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, detail TEXT, rpo_ms INTEGER, rto_ms INTEGER);
CREATE INDEX restore_drills_dest ON restore_drills(destination_id, started_at DESC);
CREATE TABLE egress (month TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (month, kind)); -- month = 'YYYY-MM'
`,
	/* 3: conditions, events, banner */ `
CREATE TABLE conditions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT, state TEXT NOT NULL,
  since INTEGER, facts TEXT NOT NULL DEFAULT '{}', last_action TEXT, last_action_at INTEGER, last_action_outcome TEXT,
  acknowledged_by TEXT, acknowledged_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE ops_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('info','handled','attention','ack')),
  condition_id TEXT, message TEXT NOT NULL, evidence TEXT);
CREATE INDEX ops_events_at ON ops_events(at DESC);
CREATE TABLE admin_visits (login TEXT PRIMARY KEY COLLATE NOCASE, last_seen_at INTEGER NOT NULL);
`
];

/** Row shapes (snake_case, as stored). */
const Int = Type.Integer();
const NInt = Type.Union([Type.Integer(), Type.Null()]);
const NStr = Type.Union([Type.String(), Type.Null()]);

export const DestinationRow = Type.Object({
	id: Type.String(), kind: Type.String(), name: Type.String(), enabled: Int, origin: Type.String(), version: Int, config: Type.String(),
	last_test_at: NInt, last_test_ok: NInt, last_test_version: NInt, created_at: Int, updated_at: Int
});
export type DestinationRow = Static<typeof DestinationRow>;

export const BackupPlanRow = Type.Object({
	id: Type.String(), name: Type.String(), enabled: Int, origin: Type.String(), version: Int, config: Type.String(),
	effective_interval_ms: Int, created_at: Int, updated_at: Int
});
export type BackupPlanRow = Static<typeof BackupPlanRow>;

export const TelemetrySinkRow = Type.Object({
	id: Type.String(), name: Type.String(), enabled: Int, origin: Type.String(), version: Int, config: Type.String(),
	last_test_at: NInt, last_test_ok: NInt, last_test_version: NInt, created_at: Int, updated_at: Int
});
export type TelemetrySinkRow = Static<typeof TelemetrySinkRow>;

export const SecretRow = Type.Object({
	id: Type.String(), name: Type.String(), kind: Type.String(),
	ciphertext: Type.Uint8Array(), iv: Type.Uint8Array(), wrapped_dek: Type.Uint8Array(), kek_id: Type.String(), fingerprint: Type.String(),
	previous_ciphertext: Type.Union([Type.Uint8Array(), Type.Null()]), previous_iv: Type.Union([Type.Uint8Array(), Type.Null()]),
	previous_wrapped_dek: Type.Union([Type.Uint8Array(), Type.Null()]), previous_kek_id: NStr, previous_expires_at: NInt,
	created_at: Int, updated_at: Int, last_used_at: NInt, last_used_ok: NInt
});
export type SecretRow = Static<typeof SecretRow>;

export const BackupRunRow = Type.Object({
	id: Type.String(), plan_id: Type.String(), database: Type.String(), state: Type.String(), attempt: Int, trigger: Type.String(),
	started_at: Int, finished_at: NInt, raw_path: NStr, raw_bytes: NInt, raw_sha256: NStr, snapshot: NStr,
	sealed_bytes: NInt, error: NStr, updated_at: Int
});
export type BackupRunRow = Static<typeof BackupRunRow>;

export const UploadRow = Type.Object({
	run_id: Type.String(), destination_id: Type.String(), state: Type.String(), attempts: Int, next_attempt_at: NInt,
	artifact_key: NStr, manifest: NStr, uploaded_bytes: Int, last_error: NStr, updated_at: Int
});
export type UploadRow = Static<typeof UploadRow>;

export const RestoreDrillRow = Type.Object({
	id: Type.String(), destination_id: Type.String(), database: Type.String(), run_id: NStr,
	started_at: Int, finished_at: NInt, result: NStr, detail: NStr, rpo_ms: NInt, rto_ms: NInt
});
export type RestoreDrillRow = Static<typeof RestoreDrillRow>;

export const ConditionRow = Type.Object({
	id: Type.String(), kind: Type.String(), subject: NStr, state: Type.String(), since: NInt, facts: Type.String(),
	last_action: NStr, last_action_at: NInt, last_action_outcome: NStr, acknowledged_by: NStr, acknowledged_at: NInt, updated_at: Int
});
export type ConditionRow = Static<typeof ConditionRow>;

export const OpsEventRow = Type.Object({ id: Int, at: Int, kind: Type.String(), condition_id: NStr, message: Type.String(), evidence: NStr });
export type OpsEventRow = Static<typeof OpsEventRow>;

export const AdminVisitRow = Type.Object({ login: Type.String(), last_seen_at: Int });
export type AdminVisitRow = Static<typeof AdminVisitRow>;

export const EgressRow = Type.Object({ month: Type.String(), kind: Type.String(), bytes: Int });
export type EgressRow = Static<typeof EgressRow>;

/** Table ownership for M1–M4 (ADR 0109): who writes which table. */
export const TABLE_OWNERS = {
	destinations: 'backups', backup_plans: 'backups', budgets: 'backups', secrets: 'backups', ops_audit: 'backups (append: all)',
	kv: 'all (key-prefixed by owner)', backup_runs: 'backups', uploads: 'backups', restore_drills: 'backups', egress: 'backups',
	telemetry_sinks: 'telemetry', conditions: 'telemetry', ops_events: 'telemetry (append: all)', admin_visits: 'telemetry'
} as const;
