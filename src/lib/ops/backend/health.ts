/**
 * `OpsBackendHealth` (ADR 0092, 0104, 0124): overview, conditions, events,
 * banner, telemetry sinks, ops actors. No method returns a secret value.
 */
import type { Banner, Condition, OpsActorSummary, OpsBackendHealth, OpsEvent, OpsStatus, Page, Resolved, TelemetrySinkConfig, TelemetrySinkDraft, TelemetryStats, TestConnectionResult } from '../contract';
import { OpsBackendError } from '../contract';
import type { ListEventsInput, TestSinkInput } from '../schemas/api';
import type { OpsContext } from '../feature';
import { conditionAddress, OPS_FAMILY } from '../schemas/events';
import { toConditionDto } from '../health/journal';
import { computeBanner } from '../health/status';
import { secretRefOf, testSinkConnection } from '../io/otlp';
import { SinksRepo, sinkFingerprint } from '../telemetry/sinks-repo';
import { droppedLast24h } from '../actors/telemetry-sink';
import type { HealthRuntime } from '../features/health';

/** A passed test proves a sink config for this long (ADR 0102 gating). */
export const TEST_VALID_MS = 60 * 60_000;
const ORDER: Record<string, number> = { attention: 0, healing: 1, suspect: 2, acknowledged: 3, ok: 4 };

export class HealthBackend implements OpsBackendHealth {
	/** fingerprint → time of a passed test (drafts not yet saved). */
	#passed = new Map<string, number>();

	constructor(
		private readonly rt: () => HealthRuntime,
		private readonly ctx: OpsContext
	) {}

	#audit(actor: string, action: string, targetId: string | null, detail?: unknown) {
		try {
			this.ctx.db
				.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES ($at, $actor, $action, $area, $id, $detail)')
				.run({ at: this.ctx.now(), actor, action, area: 'telemetry', id: targetId, detail: detail === undefined ? null : JSON.stringify(detail) });
		} catch (e) {
			this.ctx.host.log.warn('ops: audit append failed', e instanceof Error ? e.message : e);
		}
	}

	async getStatus(): Promise<OpsStatus> {
		return this.rt().status();
	}

	async getBanner(login: string): Promise<Banner> {
		return computeBanner(this.rt().journal, login.toLowerCase(), this.ctx.now());
	}

	async markVisited(login: string): Promise<void> {
		this.rt().journal.markVisited(login.toLowerCase(), this.ctx.now());
	}

	async listConditions(): Promise<Condition[]> {
		const rt = this.rt();
		return rt.journal
			.listConditions()
			.map((c) => toConditionDto(c, rt.timeScale))
			.sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (b.since ?? 0) - (a.since ?? 0));
	}

	async acknowledgeCondition(id: string, actor: string): Promise<Condition> {
		const rt = this.rt();
		const c = rt.journal.getCondition(id);
		if (!c) throw new OpsBackendError('not-found', `no condition ${id}`);
		if (c.state !== 'attention') throw new OpsBackendError('conflict', `condition ${id} is ${c.state}, not attention`);
		try {
			await this.ctx.system.send(conditionAddress(id), 'condition.acknowledge', { by: actor }, { timeout: 10_000 });
			await this.ctx.system.flush();
		} catch (e) {
			throw new OpsBackendError('unavailable', `could not acknowledge ${id}: ${e instanceof Error ? e.message : String(e)}`);
		}
		const after = rt.journal.getCondition(id) ?? c;
		return toConditionDto(after, rt.timeScale);
	}

	async listEvents(query: Resolved<ListEventsInput>): Promise<Page<OpsEvent>> {
		return this.rt().journal.listEvents(query);
	}

	async listSinks(): Promise<TelemetrySinkConfig[]> {
		return this.rt().repo.list();
	}

	#secretExists(id: string): boolean {
		try {
			return !!this.ctx.db.query('SELECT 1 FROM secrets WHERE id = $id').get({ id });
		} catch {
			return false;
		}
	}

	async saveSink(draft: TelemetrySinkDraft, actor: string): Promise<TelemetrySinkConfig> {
		const rt = this.rt();
		const previous = draft.id ? rt.repo.get(draft.id) : null;
		if (draft.id && !previous) throw new OpsBackendError('not-found', `no sink ${draft.id}`);
		if (previous && draft.version !== undefined && draft.version !== previous.version)
			throw new OpsBackendError('conflict', `sink ${previous.id} was changed by someone else (version ${previous.version})`);
		const ref = secretRefOf(draft.auth);
		if (ref && !this.#secretExists(ref)) throw new OpsBackendError('invalid', `secret ${ref} does not exist; store it on /ops/secrets first`);
		const body = SinksRepo.bodyFromDraft(draft, previous);
		const fp = sinkFingerprint(body);
		const now = this.ctx.now();
		const unchangedAndTested =
			!!previous && sinkFingerprint(previous) === fp && !!previous.lastTest?.ok && previous.lastTest.versionTested === previous.version;
		const testedDraft = (this.#passed.get(fp) ?? 0) > now - TEST_VALID_MS;
		if (draft.enabled && !unchangedAndTested && !testedDraft)
			throw new OpsBackendError('invalid', 'run the test connection with these settings before enabling the sink (ADR 0102)');
		const id = draft.id ?? this.#newId(draft.name);
		const saved = rt.repo.upsert({
			id,
			name: draft.name,
			enabled: draft.enabled,
			origin: 'ui',
			body,
			now,
			lastTest: testedDraft ? { at: this.#passed.get(fp)!, ok: true } : unchangedAndTested ? { at: previous!.lastTest!.at, ok: true } : null
		});
		this.#audit(actor, previous ? 'update' : 'create', id, { enabled: draft.enabled, endpoint: body.endpoint, auth: body.auth.mode });
		rt.reconcileSinks();
		return saved;
	}

	#newId(name: string): string {
		const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sink';
		let id = base;
		for (let i = 2; this.rt().repo.exists(id); i++) id = `${base}-${i}`;
		return id;
	}

	async deleteSink(id: string, actor: string): Promise<void> {
		const rt = this.rt();
		if (!rt.repo.delete(id)) throw new OpsBackendError('not-found', `no sink ${id}`);
		this.#audit(actor, 'delete', id);
		rt.reconcileSinks();
	}

	async testSink(input: TestSinkInput, actor: string): Promise<TestConnectionResult> {
		const rt = this.rt();
		const existing = input.id ? rt.repo.get(input.id) : null;
		if (input.id && !existing) throw new OpsBackendError('not-found', `no sink ${input.id}`);
		const target = input.draft ?? existing;
		if (!target) throw new OpsBackendError('invalid', 'give a sink id or a draft');
		const result = await testSinkConnection({
			endpoint: target.endpoint,
			auth: target.auth,
			signals: target.signals,
			secrets: this.ctx.secrets,
			candidates: input.candidateSecrets ?? {},
			redactor: rt.redactor,
			now: this.ctx.now
		});
		const fp = sinkFingerprint(target);
		if (result.ok) this.#passed.set(fp, result.at);
		if (existing && sinkFingerprint(existing) === fp && !input.candidateSecrets) rt.repo.recordTest(existing.id, result.ok, result.at, existing.version);
		this.#audit(actor, 'test', existing?.id ?? null, { ok: result.ok, endpoint: result.resolvedEndpoint });
		return result;
	}

	async getTelemetryStats(sinkId: string): Promise<TelemetryStats> {
		const rt = this.rt();
		const sink = rt.repo.get(sinkId);
		if (!sink) throw new OpsBackendError('not-found', `no sink ${sinkId}`);
		const state = rt.sinkStates().find((s) => s.sinkId === sinkId);
		const d = state?.data ?? null;
		const now = this.ctx.now();
		const dropped = d ? droppedLast24h(d, now) : { batches: 0, bytes: 0 };
		return {
			sinkId,
			windowMs: 86_400_000,
			sentBatches: d?.sent.batches ?? 0,
			sentBytes: d?.sent.bytes ?? 0,
			droppedBatches: dropped.batches,
			droppedBytes: dropped.bytes,
			bufferedBytes: d?.queuedBytes ?? 0,
			sampleRatio: rt.fanout.sampleRatio,
			volumeThisMonthBytes: rt.fanout.volumeThisMonth(sinkId),
			volumeBudgetBytes: sink.volumeBudgetBytesPerMonth,
			lastError: d?.lastError ?? null
		};
	}

	/**
	 * Import telemetry sinks from a config export (ADR 0150). Like imported
	 * destinations, sinks arrive **disabled** (enabling needs a passing test,
	 * ADR 0102); existing ids are skipped; missing secrets are reported.
	 * Not part of OpsBackendHealth: `composeBackend` calls it from importConfig.
	 */
	importSinks(raw: unknown[], actor: string): { created: number; skipped: number; missingSecrets: string[] } {
		const rt = this.rt();
		const out = { created: 0, skipped: 0, missingSecrets: [] as string[] };
		const now = this.ctx.now();
		for (const r of raw) {
			const row = (r ?? {}) as { id?: unknown; name?: unknown; config?: unknown };
			if (typeof row.id !== 'string' || typeof row.name !== 'string' || !row.config || typeof row.config !== 'object') {
				out.skipped++;
				continue;
			}
			if (rt.repo.exists(row.id)) {
				out.skipped++;
				continue;
			}
			const body = row.config as Parameters<SinksRepo['upsert']>[0]['body'];
			const ref = secretRefOf(body.auth);
			if (ref && !this.#secretExists(ref)) out.missingSecrets.push(ref);
			try {
				rt.repo.upsert({ id: row.id, name: row.name, enabled: false, origin: 'ui', body, now });
				out.created++;
			} catch (e) {
				this.ctx.host.log.warn(`ops: imported sink ${row.id} is invalid; skipped`, e instanceof Error ? e.message : e);
				out.skipped++;
			}
		}
		if (out.created) rt.reconcileSinks();
		this.ctx.host.log.info(`ops telemetry: ${actor} imported ${out.created} sink(s), skipped ${out.skipped}`);
		return out;
	}

	async listOpsActors(): Promise<OpsActorSummary[]> {
		const system = this.ctx.system;
		const out: OpsActorSummary[] = [];
		const seen = new Set<string>();
		// Addresses by runtime ID, from what the ops System spawned or loaded (ADR 0150).
		const byId = new Map<string, string>();
		for (const a of this.ctx.addresses?.() ?? []) {
			const actor = system.findActor(a);
			if (actor) byId.set(`${actor.slot}:${actor.generation}`, a.name);
		}
		for (const i of system.actors()) {
			const family = i.definition.family;
			const k = `${i.actor.slot}:${i.actor.generation}`;
			const name = byId.get(k) ?? nameOf(family, i.data);
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ address: { family, name: name ?? `#${i.actor.slot}` }, activeStates: [...i.activeStates], scheduling: i.scheduling });
		}
		return out.sort((a, b) => a.address.family.localeCompare(b.address.family) || a.address.name.localeCompare(b.address.name));
	}
}

/** Names of ops actors from their data (the inspection carries no address). */
function nameOf(family: string, data: unknown): string | null {
	const d = (data ?? {}) as Record<string, unknown>;
	switch (family) {
		case OPS_FAMILY.sink:
			return typeof d.sinkId === 'string' ? d.sinkId : null;
		case OPS_FAMILY.condition:
			return typeof d.id === 'string' ? d.id : null;
		case OPS_FAMILY.watchdog:
		case OPS_FAMILY.remediator:
		case OPS_FAMILY.config:
			return 'main';
		case OPS_FAMILY.upload:
			return typeof d.runId === 'string' && typeof d.destinationId === 'string' ? `${d.runId}.${d.destinationId}` : null;
		case OPS_FAMILY.run:
			return typeof d.runId === 'string' ? d.runId : null;
		case OPS_FAMILY.plan:
			return typeof d.planId === 'string' ? d.planId : null;
		case OPS_FAMILY.retention:
		case OPS_FAMILY.drill:
			return typeof d.destinationId === 'string' ? d.destinationId : null;
		default:
			for (const k of ['name', 'id']) if (typeof d[k] === 'string') return d[k] as string;
			return null;
	}
}
