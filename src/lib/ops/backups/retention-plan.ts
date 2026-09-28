/**
 * Retention planning: a pure function of (listing, now, schedule, caps)
 * (ADR 0096, 0112). Same input → same deletions, so repeated passes converge.
 *
 * Keys (ADR 0084): `<prefix><db>/<yyyy>/<mm>/<dd>/<runId>.sqlite.zst.aesgcm`
 * and `<same>.manifest.json`. A backup exists iff its manifest exists; a
 * backup is *verified* when both manifest and data object are present and the
 * data object is non-empty.
 */
import type { RetentionCaps, RetentionSchedule } from '../schemas/destinations';
import { PROBE_PREFIX } from '../schemas/destinations';
import type { StoreObject } from './stores';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const ORPHAN_GRACE_MS = DAY;
export const MAX_CONVERGENCE_ITERATIONS = 5;

const ARTIFACT_RE = /^([a-z][a-z0-9-]{0,31})\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9][a-z0-9-]{0,62})\.sqlite\.zst\.aesgcm$/;

export interface ListedBackup {
	database: string;
	runId: string;
	artifactKey: string;
	manifestKey: string;
	/** Commit time ≈ manifest lastModified. */
	createdAt: number;
	bytes: number;
	verified: boolean;
}

export type Tier = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface PlannedDeletion {
	key: string;
	database: string | null;
	createdAt: number | null;
	bytes: number;
	reason: string;
}

export interface RetentionPlan {
	keep: { key: string; database: string; createdAt: number; bytes: number; reason: string }[];
	delete: PlannedDeletion[];
	unknownObjects: number;
	unknownBytes: number;
	totalBytesAfter: number;
	backupsAfterPerDatabase: Record<string, number>;
	floorExceedsCap: boolean;
}

/** Group a raw listing into backups, orphans and unknown objects. */
export function parseListing(objects: StoreObject[], prefix: string) {
	const byKey = new Map(objects.map((o) => [o.key, o]));
	const backups: ListedBackup[] = [];
	const orphanData: StoreObject[] = [];
	const orphanManifests: StoreObject[] = [];
	const unknown: StoreObject[] = [];
	for (const o of objects) {
		if (!o.key.startsWith(prefix)) {
			unknown.push(o);
			continue;
		}
		const rel = o.key.slice(prefix.length);
		if (rel.startsWith(PROBE_PREFIX)) continue; // test-connection probes: transient, never counted
		if (rel.endsWith('.manifest.json')) {
			const artifactKey = o.key.slice(0, -'.manifest.json'.length);
			const m = ARTIFACT_RE.exec(artifactKey.slice(prefix.length));
			if (!m) unknown.push(o);
			else if (!byKey.has(artifactKey)) orphanManifests.push(o);
			continue;
		}
		const m = ARTIFACT_RE.exec(rel);
		if (!m) {
			unknown.push(o);
			continue;
		}
		const manifest = byKey.get(`${o.key}.manifest.json`);
		if (!manifest) {
			orphanData.push(o);
			continue;
		}
		backups.push({
			database: m[1]!,
			runId: m[5]!,
			artifactKey: o.key,
			manifestKey: manifest.key,
			createdAt: manifest.lastModified || o.lastModified,
			bytes: o.size + manifest.size,
			verified: o.size > 0
		});
	}
	return { backups, orphanData, orphanManifests, unknown };
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const utcMonth = (t: number) => new Date(t).toISOString().slice(0, 7);
function isoWeek(t: number): string {
	const d = new Date(t);
	const day = (d.getUTCDay() + 6) % 7; // Mon=0
	const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
	const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
	return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** GFS tier of each backup of one database (newest first); null = not selected. */
function selectTiers(sorted: ListedBackup[], now: number, s: RetentionSchedule): Map<ListedBackup, Tier> {
	const out = new Map<ListedBackup, Tier>();
	const seenDay = new Set<string>();
	const seenWeek = new Set<string>();
	const seenMonth = new Set<string>();
	for (const b of sorted) {
		const age = now - b.createdAt;
		const day = utcDay(b.createdAt);
		const week = isoWeek(b.createdAt);
		const month = utcMonth(b.createdAt);
		let tier: Tier | null = null;
		if (age < s.keepAllHours * HOUR) tier = 'hourly';
		else if (age < s.dailyDays * DAY && !seenDay.has(day)) tier = 'daily';
		else if (age < s.weeklyWeeks * 7 * DAY && !seenWeek.has(week)) tier = 'weekly';
		else if (age < s.monthlyMonths * 31 * DAY && !seenMonth.has(month)) tier = 'monthly';
		// A newer backup already represents its day/week/month in any tier.
		seenDay.add(day);
		seenWeek.add(week);
		seenMonth.add(month);
		if (tier) out.set(b, tier);
	}
	return out;
}

const TIER_DROP_ORDER: Tier[] = ['monthly', 'weekly', 'daily', 'hourly'];

/**
 * Plan one pass. `incoming` (make-room) is a hypothetical new backup that is
 * counted but can't be deleted, so caps hold after it lands (ADR 0096).
 */
export function planRetention(opts: {
	objects: StoreObject[];
	prefix: string;
	now: number;
	schedule: RetentionSchedule;
	caps: RetentionCaps;
	incoming?: { database: string; bytes: number } | null;
	/** "Don't prune when sick" (ADR 0096): keep GFS rejects, delete only to honour caps. */
	sick?: boolean;
}): RetentionPlan {
	const { now, schedule, caps } = opts;
	const { backups, orphanData, orphanManifests, unknown } = parseListing(opts.objects, opts.prefix);
	const del: PlannedDeletion[] = [];
	const keep: RetentionPlan['keep'] = [];

	// Orphans: manifests without data always; data without manifest after 24 h (may be in flight).
	for (const o of orphanManifests) del.push({ key: o.key, database: null, createdAt: o.lastModified, bytes: o.size, reason: 'orphan manifest (data object missing)' });
	let orphanBytesKept = 0;
	for (const o of orphanData) {
		if (now - o.lastModified > ORPHAN_GRACE_MS) del.push({ key: o.key, database: null, createdAt: o.lastModified, bytes: o.size, reason: 'orphan data object (no manifest after 24 h)' });
		else orphanBytesKept += o.size;
	}

	const byDb = new Map<string, ListedBackup[]>();
	for (const b of backups) byDb.set(b.database, [...(byDb.get(b.database) ?? []), b]);
	if (opts.incoming && !byDb.has(opts.incoming.database)) byDb.set(opts.incoming.database, []);

	type Cand = { b: ListedBackup; tier: Tier | null; floor: boolean };
	const kept: Cand[] = [];
	const unknownBytes = unknown.reduce((s, o) => s + o.size, 0);
	for (const [db, list] of byDb) {
		const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : -1));
		const tiers = selectTiers(sorted, now, schedule);
		const floorSet = new Set(sorted.filter((b) => b.verified).slice(0, schedule.floor));
		for (const b of sorted) {
			const tier = tiers.get(b) ?? (opts.sick ? 'monthly' : undefined);
			if (tier || floorSet.has(b)) kept.push({ b, tier: tier ?? null, floor: floorSet.has(b) });
			else del.push({ key: b.manifestKey, database: db, createdAt: b.createdAt, bytes: b.bytes, reason: 'outside the GFS schedule' });
		}
	}

	// Caps: drop oldest tier first, oldest within tier, never the floor (ADR 0096).
	const incomingBytes = opts.incoming?.bytes ?? 0;
	const countOf = (db: string) => kept.filter((c) => c.b.database === db).length + (opts.incoming?.database === db ? 1 : 0);
	const totalBytes = () => kept.reduce((s, c) => s + c.b.bytes, 0) + incomingBytes + unknownBytes + orphanBytesKept;
	const overCount = () => [...byDb.keys()].some((db) => countOf(db) > caps.maxBackupsPerDatabase);
	for (const tier of TIER_DROP_ORDER) {
		const candidates = kept.filter((c) => c.tier === tier && !c.floor).sort((a, b) => a.b.createdAt - b.b.createdAt);
		for (const c of candidates) {
			const dbOver = countOf(c.b.database) > caps.maxBackupsPerDatabase;
			if (!dbOver && totalBytes() <= caps.maxBytes) {
				if (!overCount()) break;
				continue;
			}
			kept.splice(kept.indexOf(c), 1);
			del.push({ key: c.b.manifestKey, database: c.b.database, createdAt: c.b.createdAt, bytes: c.b.bytes, reason: dbOver ? `cap: more than ${caps.maxBackupsPerDatabase} backups (${tier} tier)` : `cap: over ${caps.maxBytes} bytes (${tier} tier)` });
		}
	}
	for (const c of kept) keep.push({ key: c.b.manifestKey, database: c.b.database, createdAt: c.b.createdAt, bytes: c.b.bytes, reason: c.tier ? `${c.tier}${c.floor ? ' + floor' : ''}` : 'floor (newest verified)' });

	// Deleting a backup = delete manifest (un-commit) then data (ADR 0082); expand pairs.
	const expanded: PlannedDeletion[] = [];
	const manifestToArtifact = new Map(backups.map((b) => [b.manifestKey, b.artifactKey]));
	for (const d of del) {
		expanded.push(d);
		const art = manifestToArtifact.get(d.key);
		if (art) expanded.push({ key: art, database: d.database, createdAt: d.createdAt, bytes: 0, reason: `${d.reason} (data object)` });
	}
	const backupsAfterPerDatabase: Record<string, number> = {};
	for (const db of byDb.keys()) backupsAfterPerDatabase[db] = countOf(db);
	const total = totalBytes();
	// Attention only when the floor itself doesn't fit (ADR 0096). During make-room the
	// incoming backup may exceed a cap by one until the next pass — that is by design.
	const floorOnly = kept.filter((c) => c.floor);
	const floorBytes = floorOnly.reduce((s, c) => s + c.b.bytes, 0) + unknownBytes;
	const floorCount = (db: string) => floorOnly.filter((c) => c.b.database === db).length;
	const floorExceedsCap = floorBytes > caps.maxBytes || [...byDb.keys()].some((db) => floorCount(db) > caps.maxBackupsPerDatabase);
	return {
		keep,
		delete: expanded,
		unknownObjects: unknown.length,
		unknownBytes,
		totalBytesAfter: total,
		backupsAfterPerDatabase,
		floorExceedsCap
	};
}

/** Steady-state backups per database for a given interval (projection, ADR 0096). */
export function steadyStateCount(schedule: RetentionSchedule, caps: RetentionCaps, intervalMs: number): number {
	const hourly = Math.ceil((schedule.keepAllHours * HOUR) / Math.max(intervalMs, 60_000));
	return Math.min(caps.maxBackupsPerDatabase, Math.max(schedule.floor, hourly + schedule.dailyDays + schedule.weeklyWeeks + schedule.monthlyMonths));
}
