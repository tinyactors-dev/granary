/**
 * `conditions`, `ops_events` and `admin_visits` (ADR 0089, 0101, 0123).
 * Owned by the health feature; other features may append to `ops_events`
 * through `appendEvent`.
 */
import type { Database } from 'bun:sqlite';
import { check } from '../../schemas/standard';
import { AdminVisitRow, ConditionRow, OpsEventRow } from '../db/ddl';
import type { Condition, ConditionKind, ConditionState, OpsEvent, OpsEventKind, RemediationAction } from '../schemas/conditions';
import type { Page } from '../schemas/common';
import { policyFor, POLICIES } from './policies';

/** Private ladder bookkeeping kept in the `facts` column, stripped from DTOs. */
const LADDER_KEY = '_ladder';

export interface StoredCondition {
	id: string;
	kind: ConditionKind;
	subject: string | null;
	state: ConditionState;
	since: number | null;
	facts: Record<string, unknown>;
	step: number;
	tried: RemediationAction[];
	lastRemediation: { action: RemediationAction; at: number; outcome: 'done' | 'noop' | 'failed' } | null;
	acknowledgedBy: string | null;
	updatedAt: number;
}

export function parseConditionName(name: string): { kind: ConditionKind; subject: string | null } | null {
	const i = name.indexOf('.');
	const kind = (i === -1 ? name : name.slice(0, i)) as ConditionKind;
	if (!(kind in POLICIES)) return null;
	return { kind, subject: i === -1 ? null : name.slice(i + 1) };
}

export class Journal {
	constructor(private readonly db: Database) {}

	getCondition(id: string): StoredCondition | null {
		const r = this.db.query('SELECT * FROM conditions WHERE id = $id').get({ id });
		return r && check(ConditionRow, r) ? this.#fromRow(r as ConditionRow) : null;
	}

	listConditions(): StoredCondition[] {
		return this.db
			.query('SELECT * FROM conditions ORDER BY updated_at DESC')
			.all()
			.filter((r) => check(ConditionRow, r))
			.map((r) => this.#fromRow(r as ConditionRow));
	}

	/** Ids of conditions not in `ok` (so the sampler can clear vanished subjects). */
	nonOkIds(): string[] {
		return (this.db.query("SELECT id FROM conditions WHERE state != 'ok'").all() as { id: string }[]).map((r) => r.id);
	}

	hasRow(id: string): boolean {
		return !!this.db.query('SELECT 1 FROM conditions WHERE id = $id').get({ id });
	}

	#fromRow(r: ConditionRow): StoredCondition {
		let facts: Record<string, unknown> = {};
		try {
			facts = JSON.parse(r.facts) as Record<string, unknown>;
		} catch {
			/* keep empty */
		}
		const ladder = (facts[LADDER_KEY] ?? {}) as { step?: number; tried?: RemediationAction[] };
		delete facts[LADDER_KEY];
		const parsed = parseConditionName(r.id);
		return {
			id: r.id,
			kind: (parsed?.kind ?? r.kind) as ConditionKind,
			subject: r.subject,
			state: r.state as ConditionState,
			since: r.since,
			facts,
			step: ladder.step ?? 0,
			tried: ladder.tried ?? [],
			lastRemediation:
				r.last_action && r.last_action_at !== null
					? { action: r.last_action as RemediationAction, at: r.last_action_at, outcome: (r.last_action_outcome ?? 'done') as 'done' | 'noop' | 'failed' }
					: null,
			acknowledgedBy: r.acknowledged_by,
			updatedAt: r.updated_at
		};
	}

	/** Upsert a condition row and optionally append its event, in one transaction. */
	writeCondition(c: Omit<StoredCondition, 'updatedAt'>, at: number, event: { kind: OpsEventKind; message: string } | null): OpsEvent | null {
		let written: OpsEvent | null = null;
		this.db.transaction(() => {
			this.db
				.query(
					`INSERT INTO conditions (id, kind, subject, state, since, facts, last_action, last_action_at, last_action_outcome, acknowledged_by, acknowledged_at, updated_at)
					 VALUES ($id, $kind, $subject, $state, $since, $facts, $la, $laa, $lao, $ack, $acka, $at)
					 ON CONFLICT(id) DO UPDATE SET kind=$kind, subject=$subject, state=$state, since=$since, facts=$facts,
					   last_action=$la, last_action_at=$laa, last_action_outcome=$lao, acknowledged_by=$ack,
					   acknowledged_at=CASE WHEN $ack IS NULL THEN NULL ELSE COALESCE(acknowledged_at, $acka) END, updated_at=$at`
				)
				.run({
					id: c.id,
					kind: c.kind,
					subject: c.subject,
					state: c.state,
					since: c.since,
					facts: JSON.stringify({ ...c.facts, [LADDER_KEY]: { step: c.step, tried: c.tried } }),
					la: c.lastRemediation?.action ?? null,
					laa: c.lastRemediation?.at ?? null,
					lao: c.lastRemediation?.outcome ?? null,
					ack: c.acknowledgedBy,
					acka: c.acknowledgedBy ? at : null,
					at
				});
			if (event) written = this.appendEvent({ at, kind: event.kind, conditionId: c.id, message: event.message, evidence: c.facts });
		})();
		return written;
	}

	appendEvent(e: { at: number; kind: OpsEventKind; conditionId: string | null; message: string; evidence?: unknown }): OpsEvent {
		const evidence = e.evidence === undefined ? null : JSON.stringify(e.evidence);
		const r = this.db
			.query('INSERT INTO ops_events (at, kind, condition_id, message, evidence) VALUES ($at, $kind, $cid, $msg, $ev) RETURNING id')
			.get({ at: e.at, kind: e.kind, cid: e.conditionId, msg: e.message, ev: evidence }) as { id: number };
		return { id: String(r.id), at: e.at, kind: e.kind, conditionId: e.conditionId, message: e.message, evidence: e.evidence ?? null };
	}

	listEvents(q: { kind?: OpsEventKind; limit: number; before?: string }): Page<OpsEvent> {
		const before = q.before && /^[0-9]+$/.test(q.before) ? Number(q.before) : Number.MAX_SAFE_INTEGER;
		const rows = (
			q.kind
				? this.db.query('SELECT * FROM ops_events WHERE kind = $kind AND id < $before ORDER BY id DESC LIMIT $limit').all({ kind: q.kind, before, limit: q.limit + 1 })
				: this.db.query('SELECT * FROM ops_events WHERE id < $before ORDER BY id DESC LIMIT $limit').all({ before, limit: q.limit + 1 })
		).filter((r) => check(OpsEventRow, r)) as OpsEventRow[];
		const items = rows.slice(0, q.limit).map((r) => {
			let evidence: unknown = null;
			try {
				evidence = r.evidence ? JSON.parse(r.evidence) : null;
			} catch {
				evidence = r.evidence;
			}
			return { id: String(r.id), at: r.at, kind: r.kind as OpsEventKind, conditionId: r.condition_id, message: r.message, evidence };
		});
		return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
	}

	countEvents(kind: OpsEventKind, since: number): number {
		return (this.db.query('SELECT COUNT(*) AS n FROM ops_events WHERE kind = $kind AND at > $since').get({ kind, since }) as { n: number }).n;
	}

	lastVisit(login: string): number | null {
		const r = this.db.query('SELECT * FROM admin_visits WHERE login = $login').get({ login });
		return r && check(AdminVisitRow, r) ? (r as AdminVisitRow).last_seen_at : null;
	}

	markVisited(login: string, at: number): void {
		this.db
			.query('INSERT INTO admin_visits (login, last_seen_at) VALUES ($login, $at) ON CONFLICT(login) DO UPDATE SET last_seen_at = $at')
			.run({ login, at });
	}

	kvGet(key: string): string | null {
		return ((this.db.query('SELECT value FROM kv WHERE key = $k').get({ k: key }) as { value: string } | null) ?? null)?.value ?? null;
	}

	kvSet(key: string, value: string, at: number): void {
		this.db
			.query('INSERT INTO kv (key, value, updated_at) VALUES ($k, $v, $at) ON CONFLICT(key) DO UPDATE SET value = $v, updated_at = $at')
			.run({ k: key, v: value, at });
	}
}

/** DTO for the OpsBackend (ADR 0100): texts from the policy, private bookkeeping removed. */
export function toConditionDto(c: StoredCondition, timeScale = 1): Condition {
	const p = policyFor(c.kind);
	return {
		id: c.id,
		kind: c.kind,
		subject: c.subject,
		state: c.state,
		title: p.title(c.subject, c.facts),
		explanation: p.explain(c.subject, c.facts, c.tried),
		since: c.since,
		gracePeriodMs: Math.round(p.graceMs * timeScale),
		remediations: p.ladder,
		lastRemediation: c.lastRemediation,
		acknowledgedBy: c.acknowledgedBy,
		facts: c.facts
	};
}
