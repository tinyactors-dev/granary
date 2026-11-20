/**
 * The granary runtime: one tinyactors `Host` per process (ADR 0002, ADR
 * 0300), the WAL, the outbox relay, the tracer and the inbox sweeper. Kept on
 * `globalThis` so Vite HMR never creates a second one. Boot order per ADR
 * 0003 (see `startRuntime`).
 */
import { compileCharts, Host, type Actor } from '@tinyactors/node';
import { findActor } from '../charts/runtime';
import {
	ALLOWLIST_ADDRESS,
	EVENTS,
	FAMILY,
	GRANARY_SYSTEM,
	IssueKey,
	formatAddress,
	issueAddressFromKey,
	parseIssueDoneData,
	type IssueActorData,
	type IssueLoaderBinding,
	type IssueOpenedData
} from '../schemas/actors';
import type { Config } from '../schemas/config';
import { check } from '../schemas/standard';
import { parseOutboxPayload } from '../schemas/wal';
import { allowlistChart } from './actors/allowlist';
import { issueChart } from './actors/issue';
import { CATCHUP_INTERVAL_MS, deliveryCatchupChart, type DeliveryCatchupData } from './actors/delivery-catchup';
import { CATCHUP_ADDRESS, CATCHUP_EVENTS, CATCHUP_FAMILY, CATCHUP_IO_TYPE, catchupProcessor } from './github/catchup';
import { GitHubConnection } from './github/connection';
import { GitHubStore } from './github/store';
import { issueOpenedFromInbox } from './inbound';
import { granarySecretsOrNull } from './secrets';
import { GITHUB_IO_TYPE, githubProcessor } from './io/github';
import { log } from './log';
import { Relay } from './relay';
import { Tracer } from './tracing';
import { Wal } from './wal';

/** Inbox rows still `pending` after this long are re-posted by the sweeper. */
export const SWEEP_AGE_MS = 30_000;
export const SWEEP_INTERVAL_MS = 30_000;

/** Actor names (ADR 0300): `<family>/<name>`, as in traces and the admin UI. */
export const ALLOWLIST_NAME = formatAddress(ALLOWLIST_ADDRESS);
export const CATCHUP_NAME = formatAddress(CATCHUP_ADDRESS);
export const issueName = (key: string): string => formatAddress(issueAddressFromKey(key));

export interface Runtime {
	config: Config;
	devMode: boolean;
	wal: Wal;
	host: Host;
	relay: Relay;
	/** The GitHub connection: mode, secrets, auth, installations (ADR 0160). */
	github: GitHubConnection;
	tracer: Tracer;
	startedAt: number;
	/**
	 * Send `issue.opened` to its issue actor, spawning it from SQLite first
	 * (ADR 0300); false when that was refused (the sweeper retries).
	 * `traceparent` makes the actor's trace a child of the request that
	 * received the webhook (ADR 0234).
	 */
	postIssueOpened(data: IssueOpenedData, traceparent?: string): boolean;
	/** The issue actor `key`, spawned from SQLite when it is not running. */
	issueActor(key: string, traceparent?: string): Actor;
	/** Send `allowlist.replace` with the current `allowed_users`. */
	publishAllowlist(): void;
	/** Send `blocklist.replace` with the current (unexpired) `blocked_users` (ADR 0260). */
	publishBlocklist(): void;
	/** The name an actor was spawned under (`family/name`), or null (the host does not say, ADR 0300). */
	nameOf(actor: Actor): string | null;
	/** Monotonic counters since process start (ops health, ADR 0124): actors that faulted and ended. */
	stats: { faults: number };
	shutdown(reason?: string): Promise<void>;
	closed: boolean;
}

const KEY = Symbol.for('granary.runtime');
type Registry = { [KEY]?: Runtime };

export const getRuntime = (): Runtime | null => (globalThis as Registry)[KEY] ?? null;

/** What an issue actor starts from (ADR 0003): verdict → settled; outbox row → closing; else new. */
export function issueLoaderBinding(wal: Wal, key: string): IssueLoaderBinding {
	if (wal.getVerdict(key)) return { issueKey: key, phase: 'settled' };
	const outbox = wal.outboxForIssue(key);
	if (outbox) {
		const p = parseOutboxPayload(outbox.payload);
		let authorType = 'User';
		const inbox = wal.getInbox(p.deliveryId);
		if (inbox) authorType = issueOpenedFromInbox(inbox)?.authorType ?? authorType;
		return {
			issueKey: key,
			phase: 'closing',
			issue: {
				deliveryId: p.deliveryId,
				issueKey: key,
				...(p.kind ? { kind: p.kind } : {}),
				repoId: p.repoId,
				owner: p.owner,
				repo: p.repo,
				number: p.number,
				author: p.author,
				authorType,
				association: p.association,
				title: p.title,
				htmlUrl: p.htmlUrl
			}
		};
	}
	return { issueKey: key, phase: 'new' };
}

/** The issue actor's spawn params: its variables from the binding. */
export function issueParams(b: IssueLoaderBinding): IssueActorData {
	return {
		issueKey: b.issueKey,
		phase: b.phase,
		issue: b.issue ?? null,
		deliveryId: b.issue?.deliveryId ?? null,
		verdict: null,
		reason: null
	};
}

/**
 * Boot order (ADR 0003, ADR 0300): open DB → create the host → spawn
 * allowlist → start relay on pending/inflight rows → re-send every pending
 * inbox row (spawning its issue actor) → (caller accepts HTTP). Idempotent
 * per process.
 */
export function startRuntime(config: Config, opts: { devMode: boolean }): Runtime {
	const existing = getRuntime();
	if (existing && !existing.closed) return existing;

	// 1. DB
	const wal = new Wal(config.databasePath);
	for (const login of config.seedAllowlist) {
		if (wal.addAllowedUser(login, 'seed').added) log.info(`allowlist: seeded ${login}`);
	}

	// 1b. GitHub connection (ADR 0160, 0230): mode (app or none); secrets resolved at use.
	const github = new GitHubConnection({ config, store: new GitHubStore(wal.db), secrets: granarySecretsOrNull });
	github.seed();

	// 2. Host (the relay and tracer are created right after; handlers reach them late-bound)
	let relay: Relay | null = null;
	const tracer = new Tracer({ keepRecent: true });
	const stats = { faults: 0 };
	/** session → the delivery its issue actor is handling (for `onError`, which cannot read an ended actor). */
	const deliveries = new Map<string, string>();
	/** session → the name it was spawned under; the host keeps names but does not give them back. */
	const names = new Map<string, string>();
	const ended = (actor: Actor) => {
		deliveries.delete(String(actor.id));
		names.delete(String(actor.id));
	};
	const charts = compileCharts([issueChart(), allowlistChart(), deliveryCatchupChart()], { warningsAsErrors: true });
	const host = new Host(charts, {
		system: GRANARY_SYSTEM,
		config: tracer.hostConfig(),
		telemetry: (signal, data) => tracer.onExport(signal, data),
		ioProcessors: {
			[GITHUB_IO_TYPE]: githubProcessor({ wal, kickRelay: () => relay?.kick() }),
			[CATCHUP_IO_TYPE]: catchupProcessor({ connection: () => github, wal })
		},
		onDone(actor, donedata) {
			ended(actor);
			if (donedata === undefined) return;
			try {
				const done = parseIssueDoneData(donedata);
				wal.recordDone(done);
				tracer.noteDone(actor, done);
				log.info(`issue/${done.issueKey} finished: ${done.verdict} (${done.reason})`, { 'granary.issue_key': done.issueKey, 'granary.verdict': done.verdict, 'granary.reason': done.reason, 'github.delivery_id': done.deliveryId ?? undefined, 'granary.actor.address': `issue/${done.issueKey}` });
			} catch (e) {
				log.error('recording an issue\'s outcome failed', e);
			}
		},
		onError(actor, error) {
			stats.faults++;
			const deliveryId = deliveries.get(String(actor.id)) ?? null;
			ended(actor);
			try {
				if (deliveryId) wal.setInboxState(deliveryId, 'failed');
			} catch (e) {
				log.error('marking the inbox row failed failed', e);
			}
			log.error(`actor ${actor.id} faulted: ${error.status ?? ''} ${error.message}` + (deliveryId ? ` (inbox ${deliveryId} → failed)` : ''));
		},
		onHandlerError(error, effect) {
			log.error(`a handler failed${effect && 'event' in effect ? ` (${effect.event})` : ''}`, error);
		}
	});
	charts.close();
	tracer.attachHost(host);
	const spawn = (chart: string, name: string, options: { params?: object; traceparent?: string } = {}): Actor => {
		const actor = host.spawn(chart, { name, ...options } as never);
		names.set(String(actor.id), name);
		return actor;
	};

	// 3. allowlist/main
	spawn(FAMILY.allowlist, ALLOWLIST_NAME, { params: { logins: wal.allowedLogins(), blocked: wal.blocklistEntries() } });

	// 4. issue actors are spawned when something is sent to them (no loaders in 0.4, ADR 0300)
	const issueActor = (key: string, traceparent?: string): Actor => {
		const name = issueName(key);
		const running = findActor(host, name);
		if (running) return running;
		const params = issueParams(issueLoaderBinding(wal, key));
		return spawn(FAMILY.issue, name, { params, ...(traceparent ? { traceparent } : {}) });
	};

	// 5. relay
	relay = new Relay({
		wal,
		github: (payload) => github.clientForRepo({ owner: payload.owner, repo: payload.repo, repoId: payload.repoId }),
		reply: (to, event, data) => {
			if (to.family !== FAMILY.issue || !check(IssueKey, to.name)) throw new Error(`relay: unknown reply_to ${to.family}/${to.name}`);
			issueActor(to.name).send(event, data as never);
		},
		baseDelayMs: config.relayBaseDelayMs
	});
	relay.start();

	// 5b. delivery-catchup/main (ADR 0162): app mode only; spawned when the mode becomes `app`.
	const catchupTiming = catchupTimingFromEnv();
	const spawnCatchup = () => {
		if (github.mode() !== 'app' || host.closed || findActor(host, CATCHUP_NAME)) return;
		spawn(CATCHUP_FAMILY, CATCHUP_NAME, { params: catchupTiming });
		log.info('github: delivery catch-up started');
	};
	spawnCatchup();
	github.onModeChange((mode) => {
		if (mode === 'app') {
			spawnCatchup();
			findActor(host, CATCHUP_NAME)?.send(CATCHUP_EVENTS.runNow);
		}
	});

	const postIssueOpened = (data: IssueOpenedData, traceparent?: string): boolean => {
		try {
			if (!check(IssueKey, data.issueKey)) throw new Error(`invalid issue key ${data.issueKey}`);
			const actor = issueActor(data.issueKey, traceparent);
			actor.send(EVENTS.issueOpened, data as never, traceparent ? { traceparent } : undefined);
			deliveries.set(String(actor.id), data.deliveryId);
			return true;
		} catch (e) {
			log.warn(`could not send issue.opened for ${data.issueKey} (sweeper will retry)`, e);
			return false;
		}
	};

	const repostPending = (olderThan: number) => {
		let n = 0;
		for (const row of wal.pendingInbox(olderThan)) {
			const data = issueOpenedFromInbox(row);
			if (!data) {
				wal.setInboxState(row.delivery_id, 'failed');
				continue;
			}
			if (postIssueOpened(data)) n++;
		}
		return n;
	};

	// 6. re-send every pending inbox row
	const reposted = repostPending(Number.MAX_SAFE_INTEGER);
	if (reposted) log.info(`boot: re-posted ${reposted} pending inbox row(s)`);

	const sweeper = setInterval(() => {
		try {
			const n = repostPending(Date.now() - SWEEP_AGE_MS);
			if (n) log.info(`sweeper: re-posted ${n} pending inbox row(s)`);
			wal.sweepSessions();
		} catch (e) {
			log.error('sweeper failed', e);
		}
	}, SWEEP_INTERVAL_MS);
	sweeper.unref?.();

	const allowlist = () => host.actor(ALLOWLIST_NAME);
	const runtime: Runtime = {
		config,
		devMode: opts.devMode,
		wal,
		host,
		relay,
		github,
		tracer,
		startedAt: Date.now(),
		postIssueOpened,
		issueActor,
		nameOf: (actor) => names.get(String(actor.id)) ?? null,
		stats,
		publishAllowlist() {
			allowlist().send(EVENTS.allowlistReplace, { logins: wal.allowedLogins() });
		},
		publishBlocklist() {
			allowlist().send(EVENTS.blocklistReplace, { entries: wal.blocklistEntries() } as never);
		},
		closed: false,
		async shutdown(reason) {
			if (runtime.closed) return;
			runtime.closed = true;
			log.info(`shutting down${reason ? ` (${reason})` : ''}`);
			clearInterval(sweeper);
			await relay!.stop();
			for (const hook of shutdownHooks) {
				try {
					await hook();
				} catch (e) {
					log.error('shutdown hook failed', e);
				}
			}
			try {
				// Ends the open spans and hands the last telemetry to the tracer.
				await host[Symbol.asyncDispose]();
			} catch (e) {
				log.error('closing the actor host failed', e);
			}
			tracer.close();
			try {
				wal.close();
			} catch (e) {
				log.error('closing the database failed', e);
			}
			if ((globalThis as Registry)[KEY] === runtime) delete (globalThis as Registry)[KEY];
		}
	};
	(globalThis as Registry)[KEY] = runtime;
	log.info(
		`runtime up: db=${config.databasePath} github=${config.githubApiUrl} (${github.mode()}) allowlist=${wal.allowedCount()} dev=${opts.devMode}`
	);
	return runtime;
}

/** The catch-up interval in effect (ADR 0194, 0220). */
export function catchupIntervalMs(): number {
	return catchupTimingFromEnv().intervalMs ?? CATCHUP_INTERVAL_MS;
}

/** Test/ops knobs for the catch-up cadence (ADR 0194); defaults 30 s / 10 min. */
function catchupTimingFromEnv(): Partial<DeliveryCatchupData> {
	const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
	const firstDelayMs = num(process.env.GRANARY_TEST_CATCHUP_FIRST_DELAY_MS);
	const intervalMs = num(process.env.GRANARY_TEST_CATCHUP_INTERVAL_MS);
	return { ...(firstDelayMs !== undefined ? { firstDelayMs } : {}), ...(intervalMs !== undefined ? { intervalMs } : {}) };
}

const shutdownHooks: (() => void | Promise<void>)[] = [];
/** Extra teardown, run before the host closes. */
export function onShutdown(fn: () => void | Promise<void>): void {
	shutdownHooks.push(fn);
}
