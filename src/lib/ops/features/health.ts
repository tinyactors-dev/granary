/**
 * The health feature (M3 + M4, ADR 0110, 0120–0125): telemetry fan-out and
 * sinks, the watchdog, conditions and the remediator, ops metrics/logs, and
 * the `OpsBackendHealth` half of the OpsBackend.
 */
import type { Actor, Definition, LoadResult } from '@tinyactors/node';
import type { OpsContext, HealthFeature, RemediationHandler } from '../feature';
import type { OpsBackendHealth } from '../contract';
import { OPS_FAMILY, REMEDIATOR_ADDRESS, WATCHDOG_ADDRESS, sinkAddress } from '../schemas/events';
import type { ConditionState, RemediationAction } from '../schemas/conditions';
import type { TelemetrySinkConfig } from '../schemas/sinks';
import { OTLP_IO_TYPE, otlpProcessor } from '../io/otlp';
import { remediateProcessor, builtinRemediations } from '../io/remediate';
import { journalProcessor } from '../io/journal';
import { sampleProcessor } from '../io/sample';
import { telemetrySinkChart, initialSinkData, droppedLast24h, type TelemetrySinkData } from '../actors/telemetry-sink';
import { conditionChart, JOURNAL_IO_TYPE, type ConditionData } from '../actors/condition';
import { remediatorChart, REMEDIATE_IO_TYPE, type RemediatorData } from '../actors/remediator';
import { watchdogChart, SAMPLE_IO_TYPE, DEFAULT_WATCHDOG_INTERVAL_MS, type WatchdogData } from '../actors/watchdog';
import { SecretRedactor } from '../telemetry/redactor';
import { TelemetryFanout } from '../telemetry/fanout';
import { SinksRepo } from '../telemetry/sinks-repo';
import { opsLogBatch, opsMetricsBatch, type MetricPointInput } from '../telemetry/signals-out';
import { Journal, parseConditionName } from '../health/journal';
import type { Measurements, SinkState } from '../health/signals';
import { computeStatus } from '../health/status';
import { HealthBackend } from '../backend/health';
import { seedSinks } from '../telemetry/seeds';
import { masterKeyConfigured } from '../../platform/secrets/keys';

export const METRICS_INTERVAL_MS = 60_000;
const STATE_VALUE: Record<ConditionState, number> = { ok: 0, suspect: 1, healing: 2, attention: 3, acknowledged: 4 };

/** Everything the health feature holds once started; the backend reads it. */
export interface HealthRuntime {
	ctx: OpsContext;
	journal: Journal;
	repo: SinksRepo;
	fanout: TelemetryFanout;
	redactor: SecretRedactor;
	timeScale: number;
	defs: { sink: Definition<TelemetrySinkData> };
	lastMeasurements: () => Measurements | null;
	sinkStates(): (SinkState & { droppedLast24h: number; enabled: boolean; data: TelemetrySinkData | null })[];
	reconcileSinks(): void;
	/**
	 * Re-run the sink seeds and reconcile (ADR 0150): the seed sink's token
	 * secret is stored by the backups feature, which starts after health, so
	 * a token-auth seed sink is first created disabled and enabled here.
	 */
	reseedSinks(): void;
	/** Sample now (tests, acknowledge). */
	sampleNow(): void;
	status(): ReturnType<typeof computeStatus>;
}

export interface CreateHealthOptions {
	/** Remediations contributed by other features (composed in index.ts). */
	remediations: () => Partial<Record<RemediationAction, RemediationHandler>>;
}

export function createHealthFeature(options: CreateHealthOptions): HealthFeature & { runtime(): HealthRuntime | null } {
	const redactor = new SecretRedactor();
	let rt: HealthRuntime | null = null;
	let ctxRef: OpsContext | null = null;
	let journalRef: Journal | null = null;
	let repoRef: SinksRepo | null = null;
	let fanoutRef: TelemetryFanout | null = null;
	let last: Measurements | null = null;
	const timers: ReturnType<typeof setInterval>[] = [];
	const need = <T>(v: T | null, what: string): T => {
		if (v === null) throw new Error(`health feature not started (${what})`);
		return v;
	};
	const version = () => ctxRef?.host.version ?? 'dev';

	const exportEvent = (e: { at: number; kind: 'info' | 'handled' | 'attention' | 'ack'; conditionId: string | null; message: string }) => {
		fanoutRef?.write(opsLogBatch([{ at: e.at, kind: e.kind, conditionId: e.conditionId, message: redactor.redact(e.message) }], version()));
	};

	const builtins = builtinRemediations({
		setSampleRatio: (f) => {
			const fo = need(fanoutRef, 'fanout');
			fo.sampleRatio = f(fo.sampleRatio);
			return fo.sampleRatio;
		}
	});

	const io = {
		[OTLP_IO_TYPE]: otlpProcessor({
			get repo() {
				return need(repoRef, 'repo');
			},
			secrets: () => need(ctxRef, 'ctx').secrets,
			redactor,
			log: { info: (m, ...r) => ctxRef?.host.log.info(m, ...r), warn: (m, ...r) => ctxRef?.host.log.warn(m, ...r), error: (m, ...r) => ctxRef?.host.log.error(m, ...r) },
			now: () => ctxRef?.now() ?? Date.now(),
			onDelivered: (sinkId, bytes) => fanoutRef?.onDelivered(sinkId, bytes)
		} as Parameters<typeof otlpProcessor>[0]),
		[REMEDIATE_IO_TYPE]: remediateProcessor({
			ctx: () => need(ctxRef, 'ctx'),
			handlers: () => ({ ...options.remediations(), ...builtins }),
			get journal() {
				return need(journalRef, 'journal');
			},
			onEvent: exportEvent
		} as Parameters<typeof remediateProcessor>[0]),
		[JOURNAL_IO_TYPE]: journalProcessor({
			get journal() {
				return need(journalRef, 'journal');
			},
			onEvent: exportEvent,
			get log() {
				return need(ctxRef, 'ctx').host.log;
			}
		} as Parameters<typeof journalProcessor>[0]),
		[SAMPLE_IO_TYPE]: sampleProcessor({
			sampler: () => {
				const ctx = need(ctxRef, 'ctx');
				const j = need(journalRef, 'journal');
				return {
					host: ctx.host,
					db: ctx.db,
					now: ctx.now,
					sinks: () => rt?.sinkStates() ?? [],
					firstSeenAt: Number(j.kvGet('health:firstSeenAt') ?? ctx.now())
				};
			},
			get journal() {
				return need(journalRef, 'journal');
			},
			resident: (id) => {
				const ctx = ctxRef;
				return !!ctx && !!ctx.system.findActor({ family: OPS_FAMILY.condition, name: id });
			},
			onMeasured: (m) => {
				last = m;
			},
			get log() {
				return need(ctxRef, 'ctx').host.log;
			}
		} as Parameters<typeof sampleProcessor>[0])
	};

	let conditionDef: Definition<ConditionData> | null = null;

	const feature: HealthFeature & { runtime(): HealthRuntime | null } = {
		name: 'health',
		io,
		remediations: builtins,
		loaders: {
			[OPS_FAMILY.condition]: {
				load(ctx, address): LoadResult {
					const parsed = parseConditionName(address.name);
					if (!parsed || !conditionDef) return 'not-found';
					const stored = need(journalRef, 'journal').getCondition(address.name);
					const binding: Partial<ConditionData> = {
						id: address.name,
						kind: parsed.kind,
						subject: parsed.subject,
						resumeState: stored?.state ?? 'ok',
						since: stored?.since ?? null,
						step: stored?.step ?? 0,
						tried: stored?.tried ?? [],
						lastRemediation: stored?.lastRemediation ?? null,
						facts: stored?.facts ?? {},
						acknowledgedBy: stored?.acknowledgedBy ?? null,
						lastSampleAt: stored?.updatedAt ?? ctx.now(),
						lastActionAt: stored?.lastRemediation?.at ?? null,
						timeScale: rt?.timeScale ?? 1
					};
					return { spawn: conditionDef as unknown as Definition<object>, binding };
				}
			}
		},

		async start(ctx) {
			ctxRef = ctx;
			const journal = (journalRef = new Journal(ctx.db));
			const repo = (repoRef = new SinksRepo(ctx.db, ctx.host.log));
			if (!journal.kvGet('health:firstSeenAt')) journal.kvSet('health:firstSeenAt', String(ctx.now()), ctx.now());
			const timeScale = Number(ctx.host.env.GRANARY_TEST_GRACE_SCALE ?? '1');
			const sinkTimeScale = Number.isFinite(timeScale) && timeScale > 0 && timeScale < 1 ? timeScale : 1;
			const fanout = (fanoutRef = new TelemetryFanout({
				redactor,
				db: ctx.db,
				log: ctx.host.log,
				now: ctx.now,
				post: (sinkId, batch) => {
					try {
						ctx.system.post(sinkAddress(sinkId), 'telemetry.batch', batch);
						return true;
					} catch {
						return false;
					}
				}
			}));

			const sinkDef = ctx.system.define(telemetrySinkChart());
			conditionDef = ctx.system.define(conditionChart());
			const watchdogDef = ctx.system.define(watchdogChart());
			const remediatorDef = ctx.system.define(remediatorChart());
			ctx.excludeFromTraces?.(sinkDef as unknown as Definition<object>);

			const sinkActors = new Map<string, Actor<TelemetrySinkData>>();
			const reconcileSinks = () => {
				const sinks = repo.list();
				const enabled = new Map(sinks.filter((s) => s.enabled).map((s) => [s.id, s]));
				for (const [id, actor] of sinkActors) {
					if (enabled.has(id)) continue;
					try {
						if (ctx.system.exists(actor)) actor.destroy();
					} catch {
						/* gone */
					}
					sinkActors.delete(id);
				}
				for (const s of enabled.values()) {
					const existing = sinkActors.get(s.id);
					if (existing && !existing.destroyed) continue;
					sinkActors.set(s.id, ctx.spawn(sinkDef, sinkAddress(s.id), initialSinkData(s.id, s.flushIntervalMs, s.maxBufferBytes, sinkTimeScale)));
				}
				fanout.setSinks([...enabled.values()]);
			};

			const seeded = seedSinks({ repo, env: ctx.host.env, db: ctx.db, now: ctx.now(), log: ctx.host.log });
			for (const m of seeded) ctx.host.log.info(`ops telemetry: ${m}`);
			reconcileSinks();

			const interval = Number(ctx.host.env.GRANARY_TEST_WATCHDOG_INTERVAL_MS ?? DEFAULT_WATCHDOG_INTERVAL_MS) || DEFAULT_WATCHDOG_INTERVAL_MS;
			rt = {
				ctx,
				journal,
				repo,
				fanout,
				redactor,
				timeScale: Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1,
				defs: { sink: sinkDef },
				lastMeasurements: () => last,
				sinkStates: () =>
					repo.list().map((s: TelemetrySinkConfig) => {
						const actor = sinkActors.get(s.id);
						let data: TelemetrySinkData | null = null;
						let state = s.enabled ? 'idle' : 'disabled';
						if (actor && !actor.destroyed) {
							try {
								const i = actor.inspect();
								data = i.data as TelemetrySinkData;
								state = i.activeStates[0] ?? state;
							} catch {
								/* gone */
							}
						}
						return {
							sinkId: s.id,
							state,
							enabled: s.enabled,
							openedAt: data?.openedAt ?? null,
							lastError: data?.lastError ?? null,
							lastSuccessAt: data?.lastSuccessAt ?? null,
							droppedLast24h: data ? droppedLast24h(data, ctx.now()).batches : 0,
							data
						};
					}),
				reconcileSinks,
				reseedSinks: () => {
					for (const m of seedSinks({ repo, env: ctx.host.env, db: ctx.db, now: ctx.now(), log: ctx.host.log })) ctx.host.log.info(`ops telemetry: ${m}`);
					reconcileSinks();
				},
				sampleNow: () => ctx.post(WATCHDOG_ADDRESS, 'watchdog.sample-now', {}),
				status: () =>
					computeStatus({
						db: ctx.db,
						journal,
						now: ctx.now(),
						databases: ctx.host.databases.map((d) => d.id),
						masterKeyMissing: !ctx.host.devMode && !masterKeyConfigured(ctx.host.env, ctx.host.dataDir),
						sinks: rt!.sinkStates()
					})
			};
			ctx.spawn<RemediatorData>(remediatorDef, REMEDIATOR_ADDRESS, {});
			ctx.spawn<WatchdogData>(watchdogDef, WATCHDOG_ADDRESS, { intervalMs: interval, firstTickMs: Math.min(5_000, interval) });
			const metrics = setInterval(() => emitMetrics(), METRICS_INTERVAL_MS);
			metrics.unref?.();
			timers.push(metrics);
		},

		async stop() {
			for (const t of timers) clearInterval(t);
			timers.length = 0;
			fanoutRef?.stop();
		},

		backend(ctx): OpsBackendHealth {
			return new HealthBackend(() => need(rt, 'runtime'), ctx);
		},

		redactor: () => redactor,
		telemetrySink: () => need(fanoutRef, 'fanout'),
		runtime: () => rt
	};

	const startedAt = Date.now();
	function emitMetrics() {
		const r = rt;
		if (!r || !r.fanout.active()) return;
		const now = r.ctx.now();
		const wantsMetrics = r.fanout.wantsOps();
		try {
			const change = r.fanout.adjustSampling();
			if (change) {
				const message = `trace sampling ${change.to < change.from ? 'lowered' : 'raised'} to ${change.to.toFixed(2)} to keep sink ${change.sinkId} under its monthly volume (projected ${(change.projected / 1024 ** 3).toFixed(2)} GiB of ${(change.budget / 1024 ** 3).toFixed(2)} GiB)`;
				const e = r.journal.appendEvent({ at: now, kind: 'handled', conditionId: null, message, evidence: change });
				exportEvent({ ...e, conditionId: null });
			}
			r.fanout.flushVolume();
		} catch (e) {
			r.ctx.host.log.warn('ops telemetry: volume accounting failed', e instanceof Error ? e.message : e);
		}
		if (!wantsMetrics) return;
		const p: MetricPointInput[] = [];
		// Unit '' for counts and flags: Prometheus' OTLP translation would append `_ratio` for '1'.
		const g = (name: string, value: number | null | undefined, attributes?: Record<string, string>, unit = '') => {
			if (value === null || value === undefined) return;
			p.push({ name, unit, kind: 'gauge', value, attributes });
		};
		const status = r.status();
		g('ops_sleep_ok', status.sleepOk ? 1 : 0);
		g('ops_attention_items', status.attentionCount);
		for (const c of r.journal.listConditions()) g('ops_condition_state', STATE_VALUE[c.state], { id: c.id, kind: c.kind });
		for (const b of status.backups) g('ops_backup_age_seconds', b.lastVerifiedAt ? Math.round((now - b.lastVerifiedAt) / 1000) : null, { destination: b.destinationId, database: b.database }, 's');
		for (const s of r.sinkStates()) {
			if (!s.data) continue;
			g('ops_telemetry_sent_bytes', s.data.sent.bytes, { sink: s.sinkId }, 'By');
			g('ops_telemetry_dropped_bytes', s.data.dropped.bytes, { sink: s.sinkId }, 'By');
			g('ops_telemetry_buffered_bytes', s.data.queuedBytes, { sink: s.sinkId }, 'By');
			g('ops_telemetry_volume_month_bytes', r.fanout.volumeThisMonth(s.sinkId), { sink: s.sinkId }, 'By');
		}
		g('ops_telemetry_sample_ratio', r.fanout.sampleRatio, undefined, '1');
		try {
			const month = new Date(now).toISOString().slice(0, 7);
			for (const e of r.ctx.db.query('SELECT kind, bytes FROM egress WHERE month = $m').all({ m: month }) as { kind: string; bytes: number }[])
				g('ops_egress_month_bytes', e.bytes, { kind: e.kind }, 'By');
		} catch {
			/* backups feature not composed */
		}
		const m = r.lastMeasurements();
		if (m?.disk) {
			g('ops_disk_free_bytes', m.disk.freeBytes, undefined, 'By');
			g('ops_disk_total_bytes', m.disk.totalBytes, undefined, 'By');
			g('ops_db_bytes', m.disk.dbBytes, undefined, 'By');
		}
		if (m?.host) {
			g('granary_outbox_pending', m.host.outbox.pending);
			g('granary_outbox_dead', m.host.outbox.dead);
			g('granary_inbox_pending', m.host.inbox.pending);
			g('granary_dead_letters', m.host.deadLettersTotal);
			g('granary_quarantined_actors', m.host.quarantinedActors);
			g('granary_event_loop_lag_p99', m.host.process.eventLoopLagP99Ms, undefined, 'ms');
			g('granary_rss_bytes', m.host.process.rssBytes, undefined, 'By');
			const cu = m.host.catchup;
			if (cu?.enabled) {
				g('granary_catchup_redelivered_total', cu.totalRedelivered);
				g('granary_catchup_last_pass_redelivered', cu.lastPassRedelivered);
				if (cu.lastPassAt !== null) g('granary_catchup_last_pass_age_seconds', Math.round((now - cu.lastPassAt) / 1000), undefined, 's');
				g('granary_catchup_failing', cu.lastError ? 1 : 0);
			}
		}
		try {
			r.fanout.write(opsMetricsBatch(p, startedAt, now, version()));
		} catch (e) {
			r.ctx.host.log.warn('ops telemetry: could not encode metrics', e instanceof Error ? e.message : e);
		}
	}

	return feature;
}

export type { RemediatorData };
