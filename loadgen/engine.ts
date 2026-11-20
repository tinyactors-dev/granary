/**
 * The load generator engine (ADR 0070–0074): one tinyactors host with the
 * scenario coordinator and persona actors, the `github` and `host` I/O
 * processors, the fake-GitHub event subscription and per-scenario observers.
 * Used by `server.ts` (HTTP API for the dev portal) and `cli.ts` (headless).
 *
 * A persona reports its end through `onDone`: its donedata carries its id,
 * the final state's name and every variable (`PersonaDone`), frozen here.
 */
import { compileCharts, Host, StaleError, type Actor, type Send, type StateValue, type Value } from '@tinyactors/node';
import { askActor, postOTLP, telemetryConfig } from '../src/lib/charts/runtime';
import type { ChartStructure } from '../src/lib/schemas/api';
import { toJsonSafe } from '../src/lib/server/inspect/json-safe';
import type { FakeEvent } from '../fake-github/schemas';
import { FakeClient } from './fake-client';
import { subscribeEvents } from './stream';
import { Observer, type Notification } from './observer';
import { buildPlan, ConfigProblem, presetInfos, resolveConfig, type Arrival } from './plan';
import { draftText, PERSONAS, personaBinding } from './personas/index';
import { GH_ACTIONS, GITHUB_IO, HOST_IO, HOST_REQUESTS, PERSONA_EVENTS, type DraftRequest, type PersonaDone } from './personas/common';
import type { ChaosRequest } from './personas/chaos-monkey';
import type { FuzzCase } from './fuzz-cases';
import { toChart } from '../src/lib/server/inspect/chart-structure';
import { SCENARIO_EVENTS, SCENARIO_FAMILY, SCENARIO_HOST, scenarioChart, scenarioName, type ScenarioData } from './actors/scenario';
import {
	PERSONA_KINDS,
	type CreateScenarioRequest,
	type LoadgenStatus,
	type PersonaDetail,
	type PersonaKind,
	type PersonaKindCount,
	type PersonaKindInfo,
	type PersonaRef,
	type PersonaSummary,
	type ScenarioAction,
	type ScenarioConfig,
	type ScenarioDetail,
	type ScenarioState,
	type ScenarioSummary,
	type TimelineEntry,
	type TimelineKind
} from './schemas';

export interface LoadgenOptions {
	fakeGithubUrl: string;
	allowlisted: string[];
	granaryLogin: string;
	otlpEndpoint: string | null;
	log?: (msg: string) => void;
}

export class LoadgenError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 502,
		message: string,
		readonly issues?: { message: string; path: (string | number)[] }[]
	) {
		super(message);
	}
}

const MAX_TIMELINE = 300;
const TERMINAL: ScenarioState[] = ['finished', 'stopped'];

interface PersonaRecord {
	ref: PersonaRef;
	scenarioId: string;
	/** The persona's actor; null once it ended or failed to spawn. */
	actor: Actor | null;
	arrivedAt: number;
	timeline: TimelineEntry[];
	lastNote: string;
	lastActivityAt: number;
	actions: number;
	errors: number;
	finished: boolean;
	finalState: string | null;
	/** Snapshot kept once the actor ended (its donedata) or was stopped. */
	frozen: { activeStates: string[]; data: unknown } | null;
}

interface ScenarioRuntime {
	id: string;
	preset: CreateScenarioRequest['preset'] | null;
	config: ScenarioConfig;
	plan: Arrival[];
	spawned: (string | null)[];
	owner: string;
	repo: string;
	state: ScenarioState;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	activeMs: number;
	segmentStart: number | null;
	observer: Observer;
	/** The scenario actor. */
	actor: Actor | null;
	personas: Set<string>;
	log: { at: number; text: string }[];
	/** Resolved while not paused. */
	gate: Promise<void> | null;
	openGate: (() => void) | null;
	personasDoneSent: boolean;
	settledSent: boolean;
	finalizing: boolean;
}

interface Snapshot {
	activeStates: string[];
	data: unknown;
	finalState: string | null;
	live: boolean;
}

/** The state ids of a state value, outermost first (`{a: 'b'}` → `['a', 'b']`). */
function statePath(value: StateValue): string[] {
	if (typeof value === 'string') return [value];
	return Object.entries(value).flatMap(([id, child]) => [id, ...statePath(child)]);
}

export function createLoadgen(opts: LoadgenOptions) {
	const log = opts.log ?? ((m: string) => console.log(`[loadgen] ${m}`));
	const fake = new FakeClient(opts.fakeGithubUrl.replace(/\/+$/, ''));
	const scenarios = new Map<string, ScenarioRuntime>();
	const personas = new Map<string, PersonaRecord>();
	const charts = new Map<string, ChartStructure>();
	let activeScenarioId: string | null = null;

	// -------------------------------------------------------------------------
	// Host
	// -------------------------------------------------------------------------

	/** Who each live actor is, by `String(actor.id)`. */
	const actorOwners = new Map<string, { persona: string } | { scenario: string }>();

	const compiled = compileCharts([scenarioChart, ...PERSONA_KINDS.map((k) => PERSONAS[k].chart)], { warningsAsErrors: true });
	const host = new Host(compiled, {
		system: 'loadgen',
		config: opts.otlpEndpoint ? telemetryConfig('loadgen', { values: true }) : { system: { ticksPerSecond: 1000 } },
		...(opts.otlpEndpoint ? { telemetry: postOTLP(opts.otlpEndpoint) } : {}),
		ioProcessors: {
			[GITHUB_IO]: { receive: (send: Send) => githubAction(send) },
			[HOST_IO]: { receive: (send: Send) => hostRequest(send) }
		},
		onDone: (actor, donedata) => onActorDone(actor, donedata as PersonaDone | undefined),
		onError: (actor, error) => {
			const owner = actorOwners.get(String(actor.id));
			actorOwners.delete(String(actor.id));
			log(`actor ${owner ? Object.values(owner)[0] : actor.toString()} failed: ${error.message}`);
			if (owner && 'persona' in owner) {
				const p = personas.get(owner.persona);
				if (p && !p.finished) finish(p, `(failed: ${error.message})`, { activeStates: [], data: null });
			}
		},
		onHandlerError: (error) => log(`handler failed: ${(error as Error)?.message ?? String(error)}`)
	});
	compiled.close();
	if (opts.otlpEndpoint) void host.traceConfigure({ detail: 'summary', values: true });

	/** The persona that sent `send`, if it is one of ours. */
	function personaOf(send: Send): PersonaRecord | undefined {
		const owner = actorOwners.get(String(send.session));
		return owner && 'persona' in owner ? personas.get(owner.persona) : undefined;
	}

	/** Send to an actor that may have ended meanwhile; false when it has. */
	function sendTo(actor: Actor | null, event: string, data?: unknown): boolean {
		if (!actor) return false;
		try {
			actor.send(event, data as Value);
			return true;
		} catch (e) {
			if (e instanceof StaleError) return false;
			throw e;
		}
	}

	// -------------------------------------------------------------------------
	// Timeline
	// -------------------------------------------------------------------------

	function note(p: PersonaRecord, kind: TimelineKind, text: string, extra: { state?: string | null; issueNumber?: number | null } = {}) {
		const at = Date.now();
		p.timeline.push({ at, kind, text, state: extra.state ?? null, issueNumber: extra.issueNumber ?? null });
		if (p.timeline.length > MAX_TIMELINE) p.timeline.splice(0, p.timeline.length - MAX_TIMELINE);
		p.lastActivityAt = at;
		if (kind === 'narration') p.lastNote = text;
	}

	function scenarioLog(s: ScenarioRuntime, text: string) {
		s.log.push({ at: Date.now(), text });
		if (s.log.length > 200) s.log.shift();
	}

	// -------------------------------------------------------------------------
	// Event stream → observers → persona notifications
	// -------------------------------------------------------------------------

	let stream: ReturnType<typeof subscribeEvents> | null = null;
	const streamReady = (async () => {
		let since = 0;
		try {
			since = (await fake.eventsLog(0, 1)).lastSeq;
		} catch (e) {
			log(`fake GitHub not reachable yet (${(e as Error).message}); will retry via the stream`);
		}
		stream = subscribeEvents(fake.base, since, onFakeEvent, log);
	})();

	function onFakeEvent(e: FakeEvent) {
		for (const s of scenarios.values()) {
			if (TERMINAL.includes(s.state) && !s.finalizing) continue;
			const notifications = s.observer.onEvent(e);
			for (const n of notifications) deliverNotification(n);
		}
	}

	function deliverNotification(n: Notification) {
		const p = personas.get(n.personaId);
		if (!p) return;
		note(p, 'notification', n.text, { issueNumber: n.number });
		if (p.finished) return;
		sendTo(p.actor, n.event, n.data);
	}

	// -------------------------------------------------------------------------
	// `github` I/O processor: persona actions on the fake GitHub
	// -------------------------------------------------------------------------

	/** Answer the persona's action (nothing happens when it ended meanwhile). */
	function reply(send: Send, event: string, data: unknown) {
		send.answer(event, data as Value);
	}

	async function githubAction(req: Send): Promise<void> {
		const p = personaOf(req);
		if (!p) return;
		const s = scenarios.get(p.scenarioId);
		if (!s) return;
		if (s.gate) await s.gate;
		if (TERMINAL.includes(s.state)) return;
		const data = (req.data ?? {}) as Record<string, unknown>;
		s.observer.personaActions += 1;
		p.actions += 1;
		try {
			switch (req.event) {
				case GH_ACTIONS.user: {
					const u = await fake.ensureUser(String(data.login ?? p.ref.login), data.type === 'Bot' ? 'Bot' : 'User');
					note(p, 'result', `Registered ${u.login} (${u.type}).`);
					reply(req, PERSONA_EVENTS.userOk, { login: u.login });
					return;
				}
				case GH_ACTIONS.open: {
					const opened = await openIssue(s, p, {
						title: String(data.title ?? 'untitled'),
						body: typeof data.body === 'string' ? data.body : '',
						login: typeof data.login === 'string' ? data.login : p.ref.login,
						association: typeof data.association === 'string' ? data.association : undefined
					});
					reply(req, PERSONA_EVENTS.opened, opened.reply);
					for (const n of opened.queued) deliverNotification(n);
					return;
				}
				case GH_ACTIONS.reopen: {
					const number = Number(data.number);
					note(p, 'action', `Reopening #${number}.`, { issueNumber: number });
					const r = await fake.reopen({ owner: s.owner, repo: s.repo, number, actor: p.ref.login });
					note(p, 'result', `Reopened #${number} (delivery ${r.deliveryId?.slice(0, 8) ?? 'none'}).`, { issueNumber: number });
					reply(req, PERSONA_EVENTS.reopened, { number });
					return;
				}
				case GH_ACTIONS.comment: {
					const number = Number(data.number);
					const body = String(data.body ?? '…');
					note(p, 'action', `Commenting on #${number}: “${body.slice(0, 100)}”`, { issueNumber: number });
					const r = await fake.comment({ owner: s.owner, repo: s.repo, number, author: p.ref.login, body });
					reply(req, PERSONA_EVENTS.commented, { number, commentId: r.commentId });
					return;
				}
				case GH_ACTIONS.chaos: {
					const outcome = await chaos(s, p, data as unknown as ChaosRequest);
					note(p, 'result', outcome);
					reply(req, PERSONA_EVENTS.chaosDone, { outcome });
					return;
				}
				case GH_ACTIONS.fuzz: {
					const outcome = await fuzz(s, p, data.case as FuzzCase);
					note(p, 'result', outcome);
					reply(req, PERSONA_EVENTS.fuzzDone, { outcome });
					return;
				}
				default:
					throw new Error(`unknown action ${req.event}`);
			}
		} catch (e) {
			const message = (e as Error).message;
			p.errors += 1;
			s.observer.personaErrors += 1;
			note(p, 'error', `${req.event} failed: ${message}`);
			reply(req, PERSONA_EVENTS.error, { action: req.event, message });
		}
	}

	async function openIssue(
		s: ScenarioRuntime,
		p: PersonaRecord,
		o: { title: string; body: string; login: string; association?: string }
	): Promise<{ reply: { number: number; htmlUrl: string; issueKey: string }; queued: Notification[] }> {
		const association = (o.association ?? 'NONE') as never;
		note(p, 'action', `Opening an issue as ${o.login} (${o.association ?? 'NONE'}): “${o.title.slice(0, 120)}” (${o.body.length.toLocaleString('en')} chars)`);
		const r = await fake.createIssue({ owner: s.owner, repo: s.repo, author: o.login, title: o.title, body: o.body, association });
		const queued = s.observer.attachPersona(r.number, p.ref, o.title);
		const ref = s.observer.issueRef({ number: r.number, title: o.title });
		const expected = s.observer.expectedFor(o.login, o.association ?? 'NONE');
		note(p, 'result', `Opened #${r.number} — granary should ${expected === 'open' ? 'leave it open' : 'close it'}.`, { issueNumber: r.number });
		return { reply: { number: r.number, htmlUrl: ref.htmlUrl, issueKey: ref.issueKey }, queued };
	}

	async function chaos(s: ScenarioRuntime, p: PersonaRecord, c: ChaosRequest): Promise<string> {
		const base = `^/repos/${s.owner}/${s.repo}/issues/\\d+`;
		const count = Math.max(1, Math.min(2, Math.floor(c.count || 1)));
		switch (c.strike) {
			case 'comment-500':
				await fake.fault({ method: 'POST', pathPattern: `${base}/comments$`, status: 500, count });
				s.observer.markFault();
				return `Next ${count} comment POST(s) on ${s.repo} will fail with 500.`;
			case 'close-503':
				await fake.fault({ method: 'PATCH', pathPattern: `${base}$`, status: 503, count });
				s.observer.markFault();
				return `Next ${count} issue PATCH(es) on ${s.repo} will fail with 503.`;
			case 'comment-403-retry-after': {
				const retryAfter = Math.max(1, Math.min(2, Math.floor(c.retryAfter || 1)));
				await fake.fault({ method: 'POST', pathPattern: `${base}/comments$`, status: 403, count: 1, retryAfter });
				s.observer.markFault();
				return `Next comment POST on ${s.repo} gets 403 with Retry-After: ${retryAfter}.`;
			}
			case 'duplicate-delivery':
			case 'delivery-burst': {
				const id = s.observer.pickDelivery(c.pick ?? 0);
				if (!id) return 'Nothing to redeliver yet.';
				const times = c.strike === 'delivery-burst' ? 3 : 1;
				const codes: (number | null)[] = [];
				for (let i = 0; i < times; i++) {
					codes.push((await fake.redeliver(id)).responseCode);
					s.observer.redeliveries += 1;
				}
				return `Redelivered ${id.slice(0, 8)} ×${times} → ${codes.map((x) => x ?? 'unreachable').join(', ')}.`;
			}
		}
		void p;
		return 'Unknown strike.';
	}

	async function fuzz(s: ScenarioRuntime, p: PersonaRecord, c: FuzzCase): Promise<string> {
		switch (c.type) {
			case 'issue': {
				const login = c.login ?? p.ref.login;
				const r = await openIssue(s, p, { title: c.title, body: c.body, login, association: c.association });
				for (const n of r.queued) deliverNotification(n);
				return `${c.name}: opened #${r.reply.number} as ${login} (${c.association}).`;
			}
			case 'race': {
				const r = await openIssue(s, p, { title: c.title, body: '', login: p.ref.login });
				for (const n of r.queued) deliverNotification(n);
				for (let i = 0; i < c.reopens; i++) {
					await fake.reopen({ owner: s.owner, repo: s.repo, number: r.reply.number, actor: p.ref.login });
				}
				return `${c.name}: opened #${r.reply.number} and reopened it ${c.reopens}× immediately.`;
			}
			case 'raw': {
				const deliveryId = crypto.randomUUID();
				s.observer.registerRaw(deliveryId, c.name, p.ref);
				note(p, 'action', `Delivering a raw ${c.event} webhook (${c.name}, ${c.body.length.toLocaleString('en')} bytes).`);
				const r = await fake.raw({ event: c.event, action: c.action, body: c.body, deliveryId });
				return `${c.name}: granary answered ${r.responseCode ?? 'nothing (unreachable)'}.`;
			}
		}
	}

	// -------------------------------------------------------------------------
	// `host` I/O processor: narration and scenario coordination
	// -------------------------------------------------------------------------

	function hostRequest(req: Send): void {
		const owner = actorOwners.get(String(req.session));
		if (!owner) return;
		const data = (req.data ?? {}) as Record<string, unknown>;
		if ('persona' in owner) {
			const persona = personas.get(owner.persona);
			if (!persona) return;
			if (req.event === HOST_REQUESTS.narrate) {
				note(persona, 'narration', String(data.note ?? ''), { state: typeof data.state === 'string' ? data.state : null });
			} else if (req.event === HOST_REQUESTS.draft) {
				req.answer(PERSONA_EVENTS.drafted, draftText(data as unknown as DraftRequest) as Value);
			}
			return;
		}
		const s = scenarios.get(owner.scenario);
		if (!s) return;
		switch (req.event) {
			case SCENARIO_HOST.state:
				onScenarioState(s, data.state as ScenarioState, String(data.note ?? ''));
				return;
			case SCENARIO_HOST.spawn:
				spawnPersona(s, Number(data.index));
				return;
			case SCENARIO_HOST.stopPersonas:
				stopPersonas(s, String(data.reason ?? 'stopped'));
				return;
		}
	}

	function onScenarioState(s: ScenarioRuntime, state: ScenarioState, text: string) {
		const now = Date.now();
		if (s.state === 'running' && s.segmentStart !== null) {
			s.activeMs += now - s.segmentStart;
			s.segmentStart = null;
		}
		s.state = state;
		scenarioLog(s, `${state}: ${text}`);
		if (state === 'running') {
			s.startedAt ??= now;
			s.segmentStart = now;
			s.observer.start(now);
			if (s.openGate) {
				s.openGate();
				s.gate = null;
				s.openGate = null;
			}
		}
		if (state === 'paused' && !s.gate) {
			s.gate = new Promise((resolve) => (s.openGate = resolve));
		}
		if (state === 'draining') {
			// A personas.done sent while running only moved us here; draining needs its own.
			s.personasDoneSent = false;
			checkPersonasDone(s);
		}
		if (state === 'finished' || state === 'stopped') void finalize(s);
	}

	function spawnPersona(s: ScenarioRuntime, index: number) {
		const arrival = s.plan[index];
		if (!arrival || s.spawned[index]) return;
		const b = personaBinding({
			kind: arrival.kind,
			scenarioId: s.id,
			index,
			seed: s.config.seed,
			timeScale: s.config.timeScale,
			allowlisted: opts.allowlisted
		});
		const { name, ...binding } = b;
		const record: PersonaRecord = {
			ref: { id: b.id, kind: arrival.kind, name, login: b.login },
			scenarioId: s.id,
			actor: null,
			arrivedAt: Date.now(),
			timeline: [],
			lastNote: '',
			lastActivityAt: Date.now(),
			actions: 0,
			errors: 0,
			finished: false,
			finalState: null,
			frozen: null
		};
		personas.set(b.id, record);
		s.personas.add(b.id);
		s.spawned[index] = b.id;
		note(record, 'narration', `Arrived as ${b.login} (${b.association}).`, { state: null });
		try {
			record.actor = host.spawn(arrival.kind, { name: b.id, params: binding as unknown as Value });
			actorOwners.set(String(record.actor.id), { persona: b.id });
		} catch (e) {
			record.finished = true;
			record.finalState = '(failed to spawn)';
			note(record, 'error', `spawn failed: ${(e as Error).message}`);
		}
	}

	/** The persona's live state and variables, or what was frozen when it ended. */
	async function snapshotOf(p: PersonaRecord): Promise<Snapshot> {
		if (p.actor && !p.frozen) {
			try {
				const [state, context] = await Promise.all([p.actor.state(), p.actor.context()]);
				return {
					activeStates: statePath(state.value),
					data: toJsonSafe(context.variables, { maxString: 2000 }),
					finalState: null,
					live: true
				};
			} catch {
				/* ended meanwhile: fall through */
			}
		}
		return {
			activeStates: p.frozen?.activeStates ?? [],
			data: p.frozen?.data ?? null,
			finalState: p.finalState,
			live: false
		};
	}

	/** The persona ended: keep its final state and snapshot (unless stopping it already froze one). */
	function finish(p: PersonaRecord, finalState: string, frozen: PersonaRecord['frozen']) {
		p.finished = true;
		p.finalState ??= finalState;
		p.frozen ??= frozen;
		p.actor = null;
		const s = scenarios.get(p.scenarioId);
		if (s) checkPersonasDone(s);
	}

	function onActorDone(actor: Actor, done: PersonaDone | undefined) {
		const owner = actorOwners.get(String(actor.id));
		actorOwners.delete(String(actor.id));
		if (!owner || !('persona' in owner) || !done) return;
		const p = personas.get(done.persona);
		if (!p) return;
		finish(p, done.final, { activeStates: [done.final], data: toJsonSafe(done.data, { maxString: 2000 }) });
	}

	function checkPersonasDone(s: ScenarioRuntime) {
		if (s.personasDoneSent || TERMINAL.includes(s.state)) return;
		const allArrived = s.spawned.every(Boolean) || s.state === 'draining';
		if (!allArrived) return;
		for (const id of s.personas) if (!personas.get(id)?.finished) return;
		if (s.state === 'running' && !s.spawned.every(Boolean)) return;
		s.personasDoneSent = true;
		sendTo(s.actor, SCENARIO_EVENTS.personasDone);
	}

	/** Stop every persona of `s` still running: mark it finished now, freeze its snapshot, then end its actor. */
	function stopPersonas(s: ScenarioRuntime, reason: string): Promise<void> {
		const stopping: Promise<void>[] = [];
		for (const id of s.personas) {
			const p = personas.get(id);
			if (!p || p.finished) continue;
			p.finished = true;
			p.finalState = `(stopped: ${reason})`;
			stopping.push(
				(async () => {
					const snap = await snapshotOf(p);
					p.frozen ??= { activeStates: snap.activeStates, data: snap.data };
					note(p, 'narration', `Stopped by the scenario (${reason}) while ${snap.activeStates.join(', ') || '?'}.`);
					const actor = p.actor;
					p.actor = null;
					if (!actor) return;
					actorOwners.delete(String(actor.id));
					try {
						actor.terminate();
					} catch {
						/* already gone */
					}
				})()
			);
		}
		return Promise.all(stopping).then(() => undefined);
	}

	async function finalize(s: ScenarioRuntime) {
		if (s.finalizing) return;
		s.finalizing = true;
		s.endedAt = Date.now();
		if (s.gate && s.openGate) {
			s.openGate();
			s.gate = null;
			s.openGate = null;
		}
		await stopPersonas(s, s.state);
		// Let the last events arrive, then reconcile against the authoritative state.
		await Bun.sleep(300);
		let state = null;
		try {
			state = await fake.state();
		} catch (e) {
			log(`final reconcile could not read fake GitHub state: ${(e as Error).message}`);
		}
		s.observer.tick(Date.now(), 0);
		s.observer.reconcile(state);
		s.finalizing = false;
		if (activeScenarioId === s.id) activeScenarioId = null;
		scenarioLog(s, `Result: ${s.observer.violationCount()} violation(s), ${s.observer.issuesOpened()} issue(s).`);
		log(`scenario ${s.id} ${s.state}: ${s.observer.violationCount()} violation(s)`);
	}

	// Once a second: observer ticks, settling, personas-done.
	const ticker = setInterval(() => {
		const now = Date.now();
		for (const s of scenarios.values()) {
			if (s.state === 'created' || TERMINAL.includes(s.state)) continue;
			let active = 0;
			for (const id of s.personas) if (!personas.get(id)?.finished) active++;
			s.observer.tick(now, active);
			if (s.state === 'draining') checkPersonasDone(s);
			if (s.state === 'settling' && !s.settledSent && s.observer.pending() === 0) {
				s.settledSent = true;
				sendTo(s.actor, SCENARIO_EVENTS.observerSettled);
			}
		}
	}, 1000);

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	function scenarioOr404(id: string): ScenarioRuntime {
		const s = scenarios.get(id);
		if (!s) throw new LoadgenError(404, `Unknown scenario ${id}`);
		return s;
	}

	function elapsed(s: ScenarioRuntime): number {
		return s.activeMs + (s.segmentStart !== null ? Date.now() - s.segmentStart : 0);
	}

	function summary(s: ScenarioRuntime): ScenarioSummary {
		let active = 0;
		for (const id of s.personas) if (!personas.get(id)?.finished) active++;
		return {
			id: s.id,
			name: s.config.name,
			preset: s.preset ?? null,
			state: s.state,
			seed: s.config.seed,
			repo: { owner: s.owner, name: s.repo, id: s.observer.repoId },
			createdAt: s.createdAt,
			startedAt: s.startedAt,
			endedAt: s.endedAt,
			elapsedMs: Math.round(elapsed(s)),
			personasPlanned: s.plan.length,
			personasArrived: s.personas.size,
			personasActive: active,
			issuesOpened: s.observer.issuesOpened(),
			violations: s.observer.violationCount(),
			faultsActive: s.observer.lastFaultAt !== null && Date.now() - s.observer.lastFaultAt < 60_000
		};
	}

	async function personaSummary(p: PersonaRecord, snap?: Snapshot): Promise<PersonaSummary> {
		const s = scenarios.get(p.scenarioId);
		snap ??= await snapshotOf(p);
		const [opened, closed] = s ? s.observer.issueCounts(p.ref.id) : [0, 0];
		return {
			id: p.ref.id,
			kind: p.ref.kind,
			name: p.ref.name,
			login: p.ref.login,
			scenarioId: p.scenarioId,
			arrivedAt: p.arrivedAt,
			activeStates: snap.activeStates,
			finished: p.finished,
			finalState: p.finalState ?? snap.finalState,
			live: snap.live,
			issuesOpened: opened,
			issuesClosed: closed,
			actions: p.actions,
			errors: p.errors,
			lastNote: p.lastNote,
			lastActivityAt: p.lastActivityAt,
			violations: s ? s.observer.violationsFor(p.ref.id) : 0
		};
	}

	function chartOf(kind: PersonaKind): ChartStructure {
		let c = charts.get(kind);
		if (!c) {
			const file = kind === 'regular' || kind === 'maintainer' || kind === 'member' ? `loadgen/personas/${kind}.ts (shape: trusted.ts)` : `loadgen/personas/${kind}.ts`;
			c = toChart(PERSONAS[kind].chart, file);
			charts.set(kind, c);
		}
		return c;
	}

	let counter = 0;
	function newScenarioId(): string {
		counter += 1;
		return `${(Date.now() % 1_679_616).toString(36).padStart(4, '0')}${counter.toString(36)}`;
	}

	return {
		host,
		fake,
		ready: streamReady,

		status(): LoadgenStatus {
			return {
				ok: true,
				fakeGithubUrl: fake.base,
				eventStream: {
					connected: stream?.status.connected ?? false,
					lastSeq: stream?.status.lastSeq ?? 0,
					error: stream?.status.error ?? null
				},
				activeScenarioId,
				scenarios: scenarios.size,
				allowlisted: opts.allowlisted,
				granaryLogin: opts.granaryLogin,
				presets: presetInfos()
			};
		},

		kinds(): PersonaKindInfo[] {
			return PERSONA_KINDS.map((k) => ({
				kind: k,
				title: PERSONAS[k].title,
				description: PERSONAS[k].description,
				expected: PERSONAS[k].expected,
				chart: chartOf(k)
			}));
		},

		async createScenario(req: CreateScenarioRequest): Promise<ScenarioSummary> {
			let config: ScenarioConfig;
			let plan: Arrival[];
			try {
				config = resolveConfig(req);
				plan = buildPlan(config, { allowlisted: opts.allowlisted });
			} catch (e) {
				if (e instanceof ConfigProblem) throw new LoadgenError(400, e.message, e.issues);
				throw e;
			}
			if (!plan.length) throw new LoadgenError(400, 'The plan has no arrivals (duration too short for the rate?).');
			const id = newScenarioId();
			const s: ScenarioRuntime = {
				id,
				preset: req.preset ?? null,
				config,
				plan,
				spawned: plan.map(() => null),
				owner: 'loadgen',
				repo: `load-${id}`,
				state: 'created',
				createdAt: Date.now(),
				startedAt: null,
				endedAt: null,
				activeMs: 0,
				segmentStart: null,
				actor: null,
				observer: new Observer({
					owner: 'loadgen',
					repo: `load-${id}`,
					fakeUrl: fake.base,
					allowlisted: opts.allowlisted,
					granaryLogin: opts.granaryLogin,
					closeDeadlineMs: config.closeDeadlineMs,
					faultGraceMs: config.faultGraceMs
				}),
				personas: new Set(),
				log: [],
				gate: null,
				openGate: null,
				personasDoneSent: false,
				settledSent: false,
				finalizing: false
			};
			scenarios.set(id, s);
			const binding: Partial<ScenarioData> = {
				id,
				plan: plan.map((a) => ({ atMs: a.atMs, kind: a.kind })),
				durationMs: config.durationMs,
				drainTimeoutMs: Math.max(30_000, config.closeDeadlineMs * 2),
				settleTimeoutMs: config.closeDeadlineMs + config.faultGraceMs + 10_000
			};
			s.actor = host.spawn(SCENARIO_FAMILY, { name: scenarioName(id), params: binding as unknown as Value });
			actorOwners.set(String(s.actor.id), { scenario: id });
			if (req.start) await this.control(id, 'start');
			return summary(s);
		},

		async control(id: string, action: ScenarioAction): Promise<ScenarioSummary> {
			const s = scenarioOr404(id);
			if (action === 'start') {
				if (s.state !== 'created') throw new LoadgenError(409, `Scenario ${id} is ${s.state}, not created.`);
				if (activeScenarioId && activeScenarioId !== id) {
					const other = scenarios.get(activeScenarioId);
					if (other && !TERMINAL.includes(other.state)) throw new LoadgenError(409, `Scenario ${activeScenarioId} is still ${other.state}.`);
				}
				await streamReady;
				try {
					const repo = await fake.ensureRepo(s.owner, s.repo);
					s.observer.repoId = repo.id;
				} catch (e) {
					throw new LoadgenError(502, `Could not create the scenario repository on the fake GitHub: ${(e as Error).message}`);
				}
				activeScenarioId = id;
			}
			const event = { start: SCENARIO_EVENTS.start, pause: SCENARIO_EVENTS.pause, resume: SCENARIO_EVENTS.resume, stop: SCENARIO_EVENTS.stop }[action];
			if (!s.actor) throw new LoadgenError(409, `Scenario ${id} cannot ${action}: it has ended.`);
			await askActor(host, s.actor, event, undefined, 5000).catch((e: Error) => {
				throw new LoadgenError(409, `Scenario ${id} cannot ${action}: ${e.message}`);
			});
			return summary(s);
		},

		listScenarios(): ScenarioSummary[] {
			return [...scenarios.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary);
		},

		async getScenario(id: string): Promise<ScenarioDetail> {
			const s = scenarioOr404(id);
			const counts = new Map<PersonaKind, PersonaKindCount>();
			for (const pid of s.personas) {
				const p = personas.get(pid);
				if (!p) continue;
				const c = counts.get(p.ref.kind) ?? { kind: p.ref.kind, arrived: 0, active: 0, states: {} };
				c.arrived++;
				if (!p.finished) c.active++;
				const snap = await snapshotOf(p);
				const leaf = p.finalState && !snap.live ? p.finalState : snap.activeStates[snap.activeStates.length - 1] ?? p.finalState ?? '?';
				c.states[leaf] = (c.states[leaf] ?? 0) + 1;
				counts.set(p.ref.kind, c);
			}
			return {
				summary: summary(s),
				config: s.config,
				metrics: s.observer.metrics(elapsed(s)),
				series: s.observer.series(),
				invariants: s.observer.invariants(),
				violations: s.observer.violations().slice(0, 200),
				personaCounts: PERSONA_KINDS.filter((k) => counts.has(k)).map((k) => counts.get(k)!),
				plan: s.plan.slice(0, 500).map((a) => ({ index: a.index, atMs: a.atMs, kind: a.kind, personaId: s.spawned[a.index] ?? null })),
				log: [...s.log].reverse()
			};
		},

		async listPersonas(q: { scenarioId?: string; kind?: PersonaKind } = {}): Promise<PersonaSummary[]> {
			const selected = [...personas.values()].filter((p) => (!q.scenarioId || p.scenarioId === q.scenarioId) && (!q.kind || p.ref.kind === q.kind));
			const out = await Promise.all(selected.map((p) => personaSummary(p)));
			return out.sort((a, b) => a.arrivedAt - b.arrivedAt);
		},

		async getPersona(kind: string, name: string): Promise<PersonaDetail> {
			const p = personas.get(`${kind}/${name}`);
			if (!p) throw new LoadgenError(404, `Unknown persona ${kind}/${name}`);
			const s = scenarios.get(p.scenarioId);
			const snap = await snapshotOf(p);
			const spec = PERSONAS[p.ref.kind];
			return {
				summary: await personaSummary(p, snap),
				data: snap.data,
				chart: chartOf(p.ref.kind),
				timeline: [...p.timeline].reverse(),
				issues: s ? s.observer.issuesOf(p.ref.id) : [],
				kindInfo: { title: spec.title, description: spec.description, expected: spec.expected }
			};
		},

		/** Stop the active scenario, forget everything. */
		async reset() {
			for (const s of scenarios.values()) if (!TERMINAL.includes(s.state)) await stopPersonas(s, 'reset');
			for (const a of await host.actors()) {
				try {
					a.terminate();
				} catch {
					/* gone */
				}
			}
			actorOwners.clear();
			scenarios.clear();
			personas.clear();
			activeScenarioId = null;
		},

		/** Resolve when scenario `id` reaches a terminal state and is reconciled. */
		async waitForEnd(id: string, onTick?: (s: ScenarioSummary) => void, intervalMs = 2000): Promise<ScenarioDetail> {
			for (;;) {
				const s = scenarioOr404(id);
				onTick?.(summary(s));
				if (TERMINAL.includes(s.state) && !s.finalizing && s.endedAt !== null) return await this.getScenario(id);
				await Bun.sleep(intervalMs);
			}
		},

		/** Stop, and close the host once its last spans are exported. */
		async close(): Promise<void> {
			clearInterval(ticker);
			stream?.close();
			await host[Symbol.asyncDispose]();
		}
	};
}

export type Loadgen = ReturnType<typeof createLoadgen>;
