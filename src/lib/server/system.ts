/**
 * The granary runtime: one tinyactors `System` per process (ADR 0002), the
 * WAL, the outbox relay, the trace sink, the inbox sweeper and (dev only)
 * the DAP server. Kept on `globalThis` so Vite HMR never creates a second
 * one. Boot order per ADR 0003 (see `startRuntime`).
 */
import { createSystem, type Actor, type Definition, type LoadResult, type System } from '@tinyactors/node';
import {
	ALLOWLIST_ADDRESS,
	EVENTS,
	FAMILY,
	IssueKey,
	issueAddressFromKey,
	parseIssueDoneData,
	type AllowlistActorData,
	type IssueActorData,
	type IssueLoaderBinding,
	type IssueOpenedData
} from '../schemas/actors';
import type { Config } from '../schemas/config';
import { check } from '../schemas/standard';
import { parseOutboxPayload } from '../schemas/wal';
import { allowlistChart } from './actors/allowlist';
import { issueChart } from './actors/issue';
import { GitHubClient } from './github-client';
import { issueOpenedFromInbox } from './inbound';
import { GITHUB_IO_TYPE, githubProcessor } from './io/github';
import { log } from './log';
import { Relay } from './relay';
import { Tracer } from './tracing';
import { Wal } from './wal';

/** Inbox rows still `pending` after this long are re-posted by the sweeper. */
export const SWEEP_AGE_MS = 30_000;
export const SWEEP_INTERVAL_MS = 30_000;

export interface Runtime {
	config: Config;
	devMode: boolean;
	wal: Wal;
	system: System;
	relay: Relay;
	tracer: Tracer;
	startedAt: number;
	issueDefinition: Definition<IssueActorData>;
	allowlist: Actor<AllowlistActorData>;
	/** Post `issue.opened` to its issue actor; false when the queue refused it (the sweeper retries). */
	postIssueOpened(data: IssueOpenedData): boolean;
	/** Post `allowlist.replace` with the current `allowed_users`. */
	publishAllowlist(): void;
	shutdown(reason?: string): Promise<void>;
	closed: boolean;
}

const KEY = Symbol.for('granary.runtime');
type Registry = { [KEY]?: Runtime };

export const getRuntime = (): Runtime | null => (globalThis as Registry)[KEY] ?? null;

/** Build the loader binding (ADR 0003): verdict → settled; outbox row → closing; else new. */
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

function actorDataFor(b: IssueLoaderBinding): IssueActorData {
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
 * Boot order (ADR 0003): open DB → create system → spawn allowlist →
 * register issue loader → start relay on pending/inflight rows → re-post
 * every pending inbox row → (caller accepts HTTP). Idempotent per process.
 */
export function startRuntime(config: Config, opts: { devMode: boolean }): Runtime {
	const existing = getRuntime();
	if (existing && !existing.closed) return existing;

	// 1. DB
	const wal = new Wal(config.databasePath);
	for (const login of config.allowedUsersSeed) {
		if (wal.addAllowedUser(login, 'seed').added) log.info(`allowlist: seeded ${login}`);
	}

	// 2. System (the relay and tracer are created right after; hooks reach them late-bound)
	let relay: Relay | null = null;
	let tracer: Tracer | null = null;
	const system = createSystem({
		io: {
			[GITHUB_IO_TYPE]: githubProcessor({ wal, kickRelay: () => relay?.kick() })
		},
		done(record) {
			const inspection = record.actor.inspect();
			if (inspection.definition.family !== FAMILY.issue) {
				tracer?.noteActor(inspection);
				return;
			}
			try {
				const done = parseIssueDoneData(record.data);
				wal.recordDone(done);
				tracer?.noteDone(inspection, done);
				log.info(`issue/${done.issueKey} finished: ${done.verdict} (${done.reason})`);
			} catch (e) {
				log.error(`done hook failed for ${record.finalState}`, e);
			}
		},
		fault(record) {
			let deliveryId: string | null = null;
			try {
				const inspection = record.actor.inspect();
				tracer?.noteActor(inspection);
				deliveryId = (inspection.data as Partial<IssueActorData> | undefined)?.deliveryId ?? null;
				if (deliveryId) wal.setInboxState(deliveryId, 'failed');
			} catch (e) {
				log.error('fault hook failed', e);
			}
			log.error(
				`actor faulted in ${record.operation}: ${record.code} ${record.message}` +
					(deliveryId ? ` (inbox ${deliveryId} → failed)` : '')
			);
			// Free the address so a later delivery can load a fresh actor.
			queueMicrotask(() => {
				try {
					if (!system.closed && system.exists(record.actor)) system.destroy(record.actor);
				} catch {
					/* already gone */
				}
			});
		},
		deadLetter(record) {
			const target =
				'family' in record.target ? `${record.target.family}/${record.target.name}` : `#${record.target.slot}`;
			log.warn(`dead letter: ${record.event} → ${target} (${record.reason}${record.detail ? `: ${record.detail}` : ''})`);
		}
	});

	tracer = new Tracer({ system, otlpTracesUrl: config.otlpTracesUrl, keepRecent: opts.devMode });
	tracer.install();

	const issueDefinition = system.define(issueChart());
	const allowlistDefinition = system.define(allowlistChart());

	// 3. allowlist/main
	const allowlist = system.spawn(allowlistDefinition, {
		address: ALLOWLIST_ADDRESS,
		binding: { logins: wal.allowedLogins() }
	});
	tracer.noteActor(allowlist.inspect());

	// 4. issue loader
	system.setLoader(FAMILY.issue, (address): LoadResult => {
		if (!check(IssueKey, address.name)) return 'not-found';
		const binding = issueLoaderBinding(wal, address.name);
		return { spawn: issueDefinition, binding: actorDataFor(binding) };
	});

	// 5. relay
	relay = new Relay({
		wal,
		github: new GitHubClient({ apiUrl: config.githubApiUrl, token: config.githubToken }),
		system,
		baseDelayMs: config.relayBaseDelayMs
	});
	relay.start();

	const postIssueOpened = (data: IssueOpenedData): boolean => {
		try {
			system.post(issueAddressFromKey(data.issueKey), EVENTS.issueOpened, data);
			return true;
		} catch (e) {
			log.warn(`could not post issue.opened for ${data.issueKey} (sweeper will retry)`, e);
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

	// 6. re-post every pending inbox row
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

	const runtime: Runtime = {
		config,
		devMode: opts.devMode,
		wal,
		system,
		relay,
		tracer,
		startedAt: Date.now(),
		issueDefinition,
		allowlist,
		postIssueOpened,
		publishAllowlist() {
			system.post(ALLOWLIST_ADDRESS, EVENTS.allowlistReplace, { logins: wal.allowedLogins() });
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
			tracer!.close();
			try {
				system.close();
			} catch (e) {
				log.error('closing the actor system failed', e);
			}
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
		`runtime up: db=${config.databasePath} github=${config.githubApiUrl} allowlist=${wal.allowedCount()} ` +
			`traces=${config.otlpTracesUrl ?? 'off'} dev=${opts.devMode}`
	);
	return runtime;
}

const shutdownHooks: (() => void | Promise<void>)[] = [];
/** Extra teardown (e.g. the DAP server), run before the system closes. */
export function onShutdown(fn: () => void | Promise<void>): void {
	shutdownHooks.push(fn);
}
