#!/usr/bin/env bun
/**
 * `mise run ops:restore -- …` — restore a backup to a file (ADR 0105, 0116).
 *
 * Config mode (the VM still has ops.sqlite):
 *   --ops-db data/ops.sqlite --dest seed-r2 [--database granary] [--run <runId>|--latest] --out restored.sqlite
 * Direct mode (disaster recovery: only 1Password + bucket credentials):
 *   --r2-account <id> [--jurisdiction eu] --bucket b [--prefix granary/] --access-key-id <id> …
 *   --endpoint https://… [--region auto] --bucket b [--prefix granary/] --access-key-id <id> …
 *   secret access key from env GRANARY_RESTORE_SECRET_ACCESS_KEY
 * Always: GRANARY_MASTER_KEY (and GRANARY_MASTER_KEY_PREVIOUS for older backups) in the environment,
 * e.g. `fnox exec -P prod -- mise run ops:restore -- …`.
 *   --list   list committed backups instead of restoring
 *   --force  overwrite --out
 *
 * The restored file is verified: sealed/compressed/raw sha256 against the
 * manifest, PRAGMA integrity_check, and per-table row counts. Unencrypted
 * artifacts are refused (ADR 0097). Exit code 0 only when everything matches.
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openOpsDb } from '../db/open';
import { BackupsRepo, newId } from '../backups/repo';
import { loadMasterKeys } from '../../platform/secrets/keys';
import { SecretStore } from '../secrets/store';
import { openStore, type BackupStore } from '../backups/stores';
import { RestoreFailure, fetchBackup, listBackups, readManifest } from '../backups/restore';
import { SnapshotWorker } from '../backups/worker';
import { r2Endpoint, type DestinationSettings, type R2Jurisdiction } from '../schemas/destinations';

const { values: a } = parseArgs({
	options: {
		'ops-db': { type: 'string' },
		dest: { type: 'string' },
		database: { type: 'string' },
		run: { type: 'string' },
		latest: { type: 'boolean', default: false },
		out: { type: 'string' },
		list: { type: 'boolean', default: false },
		force: { type: 'boolean', default: false },
		'r2-account': { type: 'string' },
		jurisdiction: { type: 'string', default: 'eu' },
		endpoint: { type: 'string' },
		region: { type: 'string', default: 'auto' },
		bucket: { type: 'string' },
		prefix: { type: 'string', default: 'granary/' },
		'access-key-id': { type: 'string' },
		json: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false }
	},
	allowPositionals: false
});

const say = (msg: string) => !a.json && console.error(msg);
const die = (msg: string, code = 1): never => {
	if (a.json) console.log(JSON.stringify({ ok: false, error: msg }));
	else console.error(`ops:restore: ${msg}`);
	process.exit(code);
};

if (a.help) {
	console.error((await Bun.file(import.meta.path).text()).split('*/')[0]!.replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
	process.exit(0);
}

const env = process.env as Record<string, string | undefined>;
const keys = await loadMasterKeys({ env, dataDir: env.GRANARY_DATA_DIR ?? '.', devMode: false });
if (!keys.current && !keys.previous) die('no master key: set GRANARY_MASTER_KEY or pass --data with a master.key');

let store: BackupStore;
if (a['ops-db']) {
	if (!a.dest) die('--dest <destinationId> is required with --ops-db');
	const dbPath = resolve(a['ops-db']!);
	if (!existsSync(dbPath)) die(`${dbPath} does not exist`);
	const db = openOpsDb(dbPath);
	const repo = new BackupsRepo(db, () => Date.now());
	const secrets = new SecretStore({ db, keys, redactor: { registerSecretValue() {}, redact: (t) => t }, now: () => Date.now(), newId: (p) => newId(p) });
	const dest = repo.destination(a.dest!) ?? die(`destination ${a.dest} not found in ${dbPath} (known: ${repo.destinations().map((d) => d.id).join(', ')})`);
	store = await openStore(dest.settings, { secret: (ref) => secrets.reveal(ref, 'cli:ops:restore'), dataDir: resolve(dbPath, '..') });
} else {
	const secret = env.GRANARY_RESTORE_SECRET_ACCESS_KEY;
	if (!a.bucket || !a['access-key-id'] || !secret) die('direct mode needs --bucket, --access-key-id and GRANARY_RESTORE_SECRET_ACCESS_KEY (or use --ops-db)');
	let settings: DestinationSettings;
	if (a['r2-account']) {
		settings = { kind: 'r2', accountId: a['r2-account']!, jurisdiction: a.jurisdiction as R2Jurisdiction, bucket: a.bucket!, prefix: a.prefix!, accessKeyId: a['access-key-id']!, secretAccessKey: { secretRef: 'cli' }, ...(a.endpoint ? { endpointOverride: a.endpoint } : {}) };
		say(`endpoint ${r2Endpoint(a['r2-account']!, a.jurisdiction as R2Jurisdiction)}`);
	} else if (a.endpoint) {
		settings = { kind: 's3', endpoint: a.endpoint!, region: a.region!, bucket: a.bucket!, prefix: a.prefix!, virtualHostedStyle: false, accessKeyId: a['access-key-id']!, secretAccessKey: { secretRef: 'cli' } };
	} else die('direct mode needs --r2-account or --endpoint');
	store = await openStore(settings!, { secret: async () => secret!, dataDir: '.' });
}

const database = a.database ?? 'granary';
const backups = await listBackups(store, a.list ? a.database : database);
if (a.list) {
	if (a.json) console.log(JSON.stringify({ ok: true, backups }));
	else for (const b of backups) console.log(`${new Date(b.createdAt).toISOString()}  ${b.database.padEnd(10)} ${b.runId}  ${String(b.bytes).padStart(12)} B  ${b.verified ? 'verified' : 'EMPTY'}`);
	process.exit(0);
}
if (!a.out) die('--out <path> is required');
const out = resolve(a.out!);
if (existsSync(out) && !a.force) die(`${out} exists (use --force)`);
if (a.force) rmSync(out, { force: true });

const chosen = a.run ? backups.find((b) => b.runId === a.run) : backups[0];
if (!chosen) die(a.run ? `no committed backup with run id ${a.run} for ${database}` : `no committed backup of ${database}`);
say(`restoring ${chosen!.database} backup ${chosen!.runId} from ${new Date(chosen!.createdAt).toISOString()} …`);

const worker = new SnapshotWorker();
try {
	const t0 = performance.now();
	const manifest = await readManifest(store, chosen!.manifestKey);
	const { bytes } = await fetchBackup({ store, manifest, keys, outPath: out });
	const check = await worker.check(out);
	if (!check.ok) throw new RestoreFailure('integrity-failed', check.detail);
	const want = manifest.rowCounts;
	const got = check.facts.rowCounts;
	const diffs = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((t) => want[t] !== got[t]);
	if (diffs.length) throw new RestoreFailure('row-count-mismatch', diffs.map((t) => `${t}: ${got[t] ?? '∅'} ≠ ${want[t] ?? '∅'}`).join('; '));
	const summary = { ok: true, out, runId: manifest.runId, database: manifest.database, createdAt: manifest.createdAt, bytes, tables: Object.keys(got).length, rows: Object.values(got).reduce((x, y) => x + y, 0), kekId: manifest.encryption.kekId, ms: Math.round(performance.now() - t0) };
	if (a.json) console.log(JSON.stringify(summary));
	else say(`ok: ${out} (${bytes} bytes, ${summary.tables} tables, ${summary.rows} rows; integrity_check ok; row counts match the manifest) in ${summary.ms} ms`);
	worker.terminate();
	process.exit(0);
} catch (e) {
	worker.terminate();
	rmSync(out, { force: true });
	die(e instanceof RestoreFailure ? `${e.result}: ${e.message}` : String((e as Error)?.message ?? e), 2);
}
