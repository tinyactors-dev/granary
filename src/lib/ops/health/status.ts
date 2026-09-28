/**
 * `status()` and the "while you were away" banner (ADR 0100, 0104, 0123).
 *
 * sleepOk = no attention items open
 *        AND a verified off-site backup within its window (3 × effective interval)
 *        AND the last restore drill passed.
 * Shown, never pushed.
 */
import type { Database } from 'bun:sqlite';
import type { Banner, OpsStatus } from '../contract';
import type { Journal, StoredCondition } from './journal';
import { policyFor } from './policies';
import type { SinkState } from './signals';

const DAY = 86_400_000;

interface DestRow {
	id: string;
	kind: 'r2' | 's3' | 'local-dir';
	enabled: number;
}

function safeAll<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T[] {
	try {
		return db.query(sql).all(params as never) as T[];
	} catch {
		return [];
	}
}

export function computeStatus(deps: {
	db: Database;
	journal: Journal;
	now: number;
	databases: string[];
	masterKeyMissing: boolean;
	sinks: (SinkState & { droppedLast24h: number; enabled: boolean })[];
}): OpsStatus {
	const { db, journal, now } = deps;
	const conditions = journal.listConditions();
	const attention = conditions.filter((c) => c.state === 'attention');
	const reasons: string[] = attention.map((c) => policyFor(c.kind).title(c.subject, c.facts));

	const destinations = safeAll<DestRow>(db, 'SELECT id, kind, enabled FROM destinations WHERE enabled = 1');
	const plans = safeAll<{ config: string; effective_interval_ms: number }>(db, 'SELECT config, effective_interval_ms FROM backup_plans WHERE enabled = 1');
	const windowFor = (destId: string) => {
		let w = Infinity;
		for (const p of plans) {
			try {
				const c = JSON.parse(p.config) as { destinationIds?: string[] };
				if (c.destinationIds?.includes(destId)) w = Math.min(w, 3 * Math.max(60_000, p.effective_interval_ms));
			} catch {
				/* ignore */
			}
		}
		return w;
	};

	const backups: OpsStatus['backups'] = [];
	for (const d of destinations) {
		for (const database of deps.databases) {
			const last = safeAll<{ t: number | null; b: number | null }>(
				db,
				`SELECT u.updated_at AS t, u.uploaded_bytes AS b FROM uploads u JOIN backup_runs r ON r.id = u.run_id
				 WHERE u.destination_id = $d AND r.database = $db AND u.state = 'done' ORDER BY u.updated_at DESC LIMIT 1`,
				{ d: d.id, db: database }
			)[0];
			const lastVerifiedAt = last?.t ?? null;
			backups.push({
				database,
				destinationId: d.id,
				destinationKind: d.kind,
				offsite: d.kind !== 'local-dir',
				lastVerifiedAt,
				lastVerifiedBytes: last?.b ?? null,
				withinWindow: lastVerifiedAt !== null && now - lastVerifiedAt <= windowFor(d.id)
			});
		}
	}
	const offsiteOk = backups.some((b) => b.offsite && b.withinWindow);
	const offsiteExplained = attention.some((c) => c.kind === 'no-offsite-destination' || c.kind === 'offsite-backup-stale');
	if (!offsiteOk && !offsiteExplained)
		reasons.push(backups.some((b) => b.offsite) ? 'No verified off-site backup within its window' : 'No off-site backup destination');

	const drill = safeAll<{ at: number; result: string; destination_id: string }>(
		db,
		'SELECT finished_at AS at, result, destination_id FROM restore_drills WHERE finished_at IS NOT NULL AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 1'
	)[0];
	const lastDrill = drill ? { at: drill.at, result: drill.result as NonNullable<OpsStatus['lastDrill']>['result'], destinationId: drill.destination_id } : null;
	if (!lastDrill) reasons.push('No restore drill has run yet');
	else if (lastDrill.result !== 'ok') reasons.push(`Last restore drill: ${lastDrill.result}`);

	const telemetry: OpsStatus['telemetry'] = deps.sinks.map((s) => ({
		sinkId: s.sinkId,
		state: !s.enabled ? 'disabled' : (['idle', 'sending', 'backoff', 'open', 'half-open'].includes(s.state) ? s.state : s.state === 'waiting' ? 'idle' : 'idle') as OpsStatus['telemetry'][number]['state'],
		lastSuccessAt: s.lastSuccessAt,
		droppedLast24h: s.droppedLast24h
	}));

	return {
		at: now,
		mode: deps.masterKeyMissing ? 'degraded' : 'ok',
		sleepOk: attention.length === 0 && offsiteOk && lastDrill?.result === 'ok',
		reasons: [...new Set(reasons)],
		attentionCount: attention.length,
		handledLast24h: journal.countEvents('handled', now - DAY),
		backups,
		lastDrill,
		telemetry
	};
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

export function computeBanner(journal: Journal, login: string, now: number): Banner {
	const since = journal.lastVisit(login);
	const attention: StoredCondition[] = journal.listConditions().filter((c) => c.state === 'attention');
	const handledCount = journal.countEvents('handled', since ?? now - DAY);
	const parts: string[] = [];
	if (handledCount) parts.push(`${handledCount} thing${handledCount === 1 ? '' : 's'} handled automatically`);
	if (attention.length) parts.push(`${attention.length} need${attention.length === 1 ? 's' : ''} you`);
	const lead = since ? `Since ${hhmm(since)}` : 'In the last 24 h';
	return {
		since,
		handledCount,
		attention: attention.map((c) => ({ id: c.id, title: policyFor(c.kind).title(c.subject, c.facts), since: c.since })),
		summary: parts.length ? `${lead}: ${parts.join(', ')}.` : 'All quiet.',
		show: attention.length > 0 || handledCount > 0
	};
}
