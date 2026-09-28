/**
 * Canned load-generator data for the StubBackend (ADR 0076): two scenarios
 * (one finished with a violation, one "running" that advances with the
 * wall clock) and a population of personas whose statecharts are the real
 * ones from `loadgen/personas`. In-memory; create/start/stop mutate it.
 */
import { toChart } from './inspect/chart-structure';
import { PERSONAS } from '../../../loadgen/personas/index';
import { DEFAULT_CONFIG, presetInfos, PRESETS } from '../../../loadgen/plan';
import { INVARIANTS } from '../../../loadgen/observer';
import {
	PERSONA_KINDS,
	type CreateScenarioRequest,
	type InvariantId,
	type ListPersonasQuery,
	type PersonaDetail,
	type PersonaIssue,
	type PersonaKind,
	type PersonaKindInfo,
	type PersonaSummary,
	type ScenarioAction,
	type ScenarioConfig,
	type ScenarioDetail,
	type ScenarioState,
	type ScenarioSummary,
	type SeriesPoint,
	type TimelineEntry,
	type Violation
} from '../../../loadgen/schemas';
import type { LoadgenInfo } from '../schemas/dev';
import { BackendError } from './backend';

interface StubPersona {
	summary: PersonaSummary;
	data: Record<string, unknown>;
	timeline: TimelineEntry[];
	issues: PersonaIssue[];
}

interface StubScenario {
	summary: ScenarioSummary;
	config: ScenarioConfig;
	violations: Violation[];
	log: { at: number; text: string }[];
	startedMs: number;
}

const FAKE = 'http://localhost:4010';
const TERMINAL: ScenarioState[] = ['finished', 'stopped'];

/** Per kind: [leaf state while active, final state, narration lines]. */
const STORY: Record<PersonaKind, { active: string; final: string; lines: [string, string][] }> = {
	'slop-fixer': {
		active: 'lurking',
		final: 'vanished',
		lines: [
			['arriving', 'Found the repo. Plans to "fix" it with 2 issue(s).'],
			['drafting', 'Pasting 41 KB of generated text and logs.'],
			['lurking', 'Opened #3. Will not read any replies.'],
			['vanished', 'Vanished. Opened 2 issue(s), ignored 4 notification(s).']
		]
	},
	'persistent-contributor': {
		active: 'stewing',
		final: 'gaveUp',
		lines: [
			['arriving', 'Has a feature request and will not take no for an answer (gives up after 3 closures).'],
			['drafting', 'Writing issue #1 in a polite tone: "Please add YAML support to the parser"'],
			['waiting', 'Waiting for a maintainer to respond on #5…'],
			['stewing', 'Closed again (1×). Now insistent; will reopen it.'],
			['waitingAfterReopen', 'Reopened #5 themselves. Watching it like a hawk.'],
			['drafting', 'Writing issue #2 in a annoyed tone: "AGAIN: Please add YAML support to the parser — why was this closed???"'],
			['stewing', 'Closed again (2×). Now annoyed; will open a near-duplicate.'],
			['ragequitting', 'Closed 3 times. Leaving a parting comment on #11.'],
			['gaveUp', 'Gave up after 3 closure(s) and 3 issue(s).']
		]
	},
	regular: {
		active: 'watching',
		final: 'done',
		lines: [
			['arriving', 'An allowlisted regular (alice, NONE) plans 2 issue(s).'],
			['drafting', 'Writing: "cache: crash when input is empty"'],
			['watching', 'Opened #4; expects it to stay open.'],
			['done', 'Done: 2 issue(s), all still open.']
		]
	},
	maintainer: {
		active: 'watching',
		final: 'done',
		lines: [
			['arriving', 'A maintainer (maint-demo-4, OWNER) plans 1 issue(s).'],
			['watching', 'Opened #6; expects it to stay open.'],
			['done', 'Done: 1 issue(s), all still open.']
		]
	},
	member: {
		active: 'commenting',
		final: 'done',
		lines: [
			['arriving', 'An org member (member-demo-5, MEMBER) plans 2 issue(s).'],
			['commenting', 'Adding a follow-up on #7.'],
			['done', 'Done: 2 issue(s), all still open.']
		]
	},
	'first-timer': {
		active: 'hopeful',
		final: 'movedOn',
		lines: [
			['arriving', 'Nervously opening their very first GitHub issue.'],
			['hopeful', 'Hoping someone answers #8.'],
			['replying', "Read the bot's explanation on #8; writing a polite reply."],
			['waitingPatiently', 'Replied once. Waiting patiently; will not reopen.'],
			['movedOn', 'Moved on.']
		]
	},
	bot: {
		active: 'flooding',
		final: 'sleeping',
		lines: [
			['booting', 'Bot lgbot-demo-7[bot] registering; will open 9 issues.'],
			['sleeping', 'Flood done: 9 issue(s).']
		]
	},
	'chaos-monkey': {
		active: 'lurking',
		final: 'retired',
		lines: [
			['lurking', 'Lurking (0/4 strikes so far).'],
			['striking', 'Strike: comment-500.'],
			['assessing', 'Outcome: Next 2 comment POST(s) on load-demo will fail with 500.'],
			['striking', 'Strike: delivery-burst.'],
			['retired', 'Retired after 4 strike(s).']
		]
	},
	fuzzer: {
		active: 'cooling',
		final: 'exhausted',
		lines: [
			['preparing', 'Loaded 9 cases: huge-body, ping, rtl-zalgo, allowlisted-uppercase, issues-array-body, …'],
			['executing', 'Case 3/9: raw issues-array-body'],
			['cooling', 'issues-array-body: granary answered 400.'],
			['exhausted', 'Exhausted 9 case(s).']
		]
	}
};

export class StubLoadgen {
	#scenarios = new Map<string, StubScenario>();
	#personas = new Map<string, StubPersona>();
	#counter = 0;
	readonly #born = Date.now();

	constructor() {
		this.#seed('demo', 'smoke', 'finished', 42, 12, true);
		this.#seed('live', 'chaos', 'running', 7, 10, false);
	}

	#seed(id: string, preset: keyof typeof PRESETS, state: ScenarioState, seed: number, count: number, withViolation: boolean) {
		const now = Date.now();
		const config = { ...PRESETS[preset].config, seed };
		const startedAt = state === 'running' ? now - 20_000 : now - 25 * 60_000;
		const kinds = PERSONA_KINDS.filter((k) => (config.mix[k] ?? 0) > 0);
		const personas: string[] = [];
		let issueNo = 1;
		for (let i = 0; i < count; i++) {
			const kind = kinds[(i * 7 + seed) % kinds.length]!;
			const name = `${id}-${String(i + 1).padStart(3, '0')}`;
			const finished = state !== 'running' || i % 3 === 0;
			const story = STORY[kind];
			const lines = finished ? story.lines : story.lines.filter(([st]) => st !== story.final);
			const arrivedAt = startedAt + i * 1500;
			const expected = PERSONAS[kind].expected === 'open' ? 'open' : 'closed';
			const nIssues = kind === 'bot' ? 3 : kind === 'chaos-monkey' ? 0 : kind === 'persistent-contributor' ? 2 : 1;
			const issues: PersonaIssue[] = [];
			for (let k = 0; k < nIssues; k++) {
				const number = issueNo++;
				const violated = withViolation && i === 1 && k === 0;
				const closed = expected === 'closed' && !violated;
				issues.push({
					number,
					repoId: 1790000000000,
					issueKey: `1790000000000-${number}`,
					htmlUrl: `${FAKE}/loadgen/load-${id}/issues/${number}`,
					title: kind === 'bot' ? `Bump left-pad from 1.${k}.0 to 1.${k + 1}.0` : `${PERSONAS[kind].title}'s issue`,
					expected,
					state: closed ? 'closed' : 'open',
					closedBy: closed ? 'granary[bot]' : null,
					latencyMs: closed ? 8 + ((i * 37 + k * 11) % 40) : null,
					granaryComments: closed ? 1 : 0,
					reopened: kind === 'persistent-contributor' && k === 0 ? 1 : 0,
					outcome: violated ? 'violation' : 'as-expected',
					timeline: [
						{ at: arrivedAt + 2000, type: 'opened', by: `${PERSONAS[kind].prefix}-${id}-${i + 1}`, detail: `opened — granary should leave it ${expected}` },
						{ at: arrivedAt + 2003, type: 'delivery', by: null, detail: 'issues.opened → 202 (attempt 1)' },
						...(closed
							? ([
									{ at: arrivedAt + 2010, type: 'comment', by: 'granary[bot]', detail: 'Thanks for the report! Issues in this repository can only be opened by approved contributors… <!-- granary:close:… -->' },
									{ at: arrivedAt + 2012, type: 'closed', by: 'granary[bot]', detail: 'closed by granary[bot] as not_planned 12 ms after opening' }
								] as const)
							: [])
					]
				});
			}
			const timeline: TimelineEntry[] = [];
			let t = arrivedAt;
			for (const [st, text] of lines) {
				t += 900;
				timeline.push({ at: t, kind: 'narration', state: st, text, issueNumber: null });
				if (st === 'drafting' || st === 'booting' || st === 'executing') {
					timeline.push({ at: t + 300, kind: 'action', state: null, text: `Opening an issue as ${kind}…`, issueNumber: null });
					if (issues[0]) {
						timeline.push({ at: t + 320, kind: 'result', state: null, text: `Opened #${issues[0].number} — granary should ${expected === 'open' ? 'leave it open' : 'close it'}.`, issueNumber: issues[0].number });
						if (expected === 'closed') timeline.push({ at: t + 340, kind: 'notification', state: null, text: `granary[bot] closed #${issues[0].number} as not_planned (12 ms after opening)`, issueNumber: issues[0].number });
					}
				}
			}
			timeline.reverse();
			const activeState = finished ? story.final : story.active;
			const persona: StubPersona = {
				summary: {
					id: `${kind}/${name}`,
					kind,
					name,
					login: kind === 'regular' ? 'alice' : `${PERSONAS[kind].prefix}-${id}-${i + 1}${kind === 'bot' ? '[bot]' : ''}`,
					scenarioId: id,
					arrivedAt,
					activeStates: finished ? [] : [activeState],
					finished,
					finalState: finished ? story.final : null,
					live: !finished,
					issuesOpened: issues.length,
					issuesClosed: issues.filter((x) => x.closedBy).length,
					actions: timeline.filter((e) => e.kind === 'action').length + 1,
					errors: 0,
					lastNote: timeline.find((e) => e.kind === 'narration')?.text ?? '',
					lastActivityAt: t,
					violations: issues.some((x) => x.outcome === 'violation') ? 1 : 0
				},
				data: {
					id: `${kind}/${name}`,
					kind,
					scenarioId: id,
					login: `${PERSONAS[kind].prefix}-${id}-${i + 1}`,
					association: kind === 'maintainer' ? 'OWNER' : kind === 'member' ? 'MEMBER' : kind === 'first-timer' ? 'FIRST_TIME_CONTRIBUTOR' : 'NONE',
					rng: 2654435761 + i,
					timeScale: config.timeScale,
					wait: 1840,
					issues: issues.map((x) => x.number),
					current: issues[0]?.number ?? null,
					opened: issues.length,
					notifications: issues.filter((x) => x.closedBy).length,
					errors: 0,
					...(kind === 'persistent-contributor' ? { tone: 2, closures: 2, maxClosures: 3, attempts: 2, plan: 'duplicate' } : {}),
					...(kind === 'chaos-monkey' ? { strikes: 2, maxStrikes: 4, strike: 'delivery-burst', lastOutcome: 'Redelivered 3f2a1b9c ×3 → 202, 202, 202.' } : {})
				},
				timeline,
				issues
			};
			this.#personas.set(persona.summary.id, persona);
			personas.push(persona.summary.id);
		}
		const allIssues = personas.flatMap((pid) => this.#personas.get(pid)!.issues);
		const violations: Violation[] = [];
		if (withViolation) {
			const p = this.#personas.get(personas[1]!)!;
			const issue = p.issues[0];
			if (issue) {
				const inv: InvariantId = issue.expected === 'open' ? 'allowed-stay-open' : 'eventually-closed';
				violations.push({
					id: 'v1',
					invariant: inv,
					at: startedAt + 60_000,
					message: inv === 'eventually-closed' ? `#${issue.number} by ${p.summary.login} (NONE) was not closed within 30.0 s.` : `granary closed #${issue.number} by ${p.summary.login}, who is allowed.`,
					persona: { id: p.summary.id, kind: p.summary.kind, name: p.summary.name, login: p.summary.login },
					issue: { number: issue.number, repoId: issue.repoId, issueKey: issue.issueKey, htmlUrl: issue.htmlUrl, title: issue.title },
					timeline: issue.timeline
				});
			}
		}
		this.#scenarios.set(id, {
			summary: {
				id,
				name: preset,
				preset,
				state,
				seed,
				repo: { owner: 'loadgen', name: `load-${id}`, id: 1790000000000 },
				createdAt: startedAt - 1000,
				startedAt,
				endedAt: state === 'running' ? null : startedAt + 32_000,
				elapsedMs: 0,
				personasPlanned: state === 'running' ? count + 6 : count,
				personasArrived: count,
				personasActive: personas.filter((pid) => !this.#personas.get(pid)!.summary.finished).length,
				issuesOpened: allIssues.length,
				violations: violations.length,
				faultsActive: state === 'running'
			},
			config,
			violations,
			log: [
				{ at: startedAt, text: `running: Running; ${count} arrivals to go.` },
				...(state === 'running' ? [] : [{ at: startedAt + 32_000, text: `finished: Finished.` }])
			].reverse(),
			startedMs: startedAt
		});
	}

	info(): LoadgenInfo {
		return {
			url: 'http://localhost:4040 (stub)',
			reachable: true,
			error: null,
			status: {
				ok: true,
				fakeGithubUrl: FAKE,
				eventStream: { connected: true, lastSeq: 1234, error: null },
				activeScenarioId: [...this.#scenarios.values()].find((s) => s.summary.state === 'running')?.summary.id ?? null,
				scenarios: this.#scenarios.size,
				allowlisted: ['alice', 'carol', 'dave'],
				granaryLogin: 'granary[bot]',
				presets: presetInfos()
			}
		};
	}

	#get(id: string): StubScenario {
		const s = this.#scenarios.get(id);
		if (!s) throw new BackendError('not-found', `Unknown scenario ${id}`);
		return s;
	}

	#elapsed(s: StubScenario): number {
		if (s.summary.state === 'running') return Date.now() - s.startedMs;
		if (s.summary.endedAt && s.summary.startedAt) return s.summary.endedAt - s.summary.startedAt;
		return 0;
	}

	#summary(s: StubScenario): ScenarioSummary {
		return { ...s.summary, elapsedMs: this.#elapsed(s) };
	}

	listScenarios(): ScenarioSummary[] {
		return [...this.#scenarios.values()].sort((a, b) => b.summary.createdAt - a.summary.createdAt).map((s) => this.#summary(s));
	}

	getScenario(id: string): ScenarioDetail {
		const s = this.#get(id);
		const personas = [...this.#personas.values()].filter((p) => p.summary.scenarioId === id);
		const issues = personas.flatMap((p) => p.issues);
		const elapsed = this.#elapsed(s);
		const seconds = Math.max(1, Math.floor(elapsed / 1000));
		const series: SeriesPoint[] = [];
		const total = issues.length;
		const closedTotal = issues.filter((x) => x.closedBy).length;
		for (let t = 0; t <= Math.min(seconds, 600); t++) {
			const f = Math.min(1, t / Math.max(1, Math.min(seconds, 30)));
			const opened = Math.round(total * f);
			const closed = Math.max(0, Math.min(closedTotal, Math.round(closedTotal * Math.max(0, f - 0.04))));
			series.push({
				t,
				opened,
				closed,
				backlog: Math.max(0, Math.round((total - closedTotal) * 0 + (opened - closed) * 0.4)),
				p95: t > 1 ? 12 + ((t * 7) % 30) : null,
				deliveries: opened + Math.round(opened * 0.3),
				errors: 0,
				activePersonas: Math.max(0, Math.round(personas.length * (1 - f)))
			});
		}
		const latencies = issues.map((x) => x.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
		const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]! : null);
		const counts = new Map<PersonaKind, { kind: PersonaKind; arrived: number; active: number; states: Record<string, number> }>();
		for (const p of personas) {
			const c = counts.get(p.summary.kind) ?? { kind: p.summary.kind, arrived: 0, active: 0, states: {} };
			c.arrived++;
			if (!p.summary.finished) c.active++;
			const leaf = p.summary.finalState ?? p.summary.activeStates.at(-1) ?? '?';
			c.states[leaf] = (c.states[leaf] ?? 0) + 1;
			counts.set(p.summary.kind, c);
		}
		const violatedBy = new Set(s.violations.map((v) => v.invariant));
		const finalized = TERMINAL.includes(s.summary.state);
		return {
			summary: this.#summary(s),
			config: s.config,
			metrics: {
				issuesOpened: total,
				expectedOpen: issues.filter((x) => x.expected === 'open').length,
				expectedClosed: issues.filter((x) => x.expected === 'closed').length,
				closedByGranary: closedTotal,
				allowedOpen: issues.filter((x) => x.expected === 'open' && x.state === 'open').length,
				pendingClose: 0,
				overdue: s.violations.filter((v) => v.invariant === 'eventually-closed').length,
				reopenedByUsers: issues.reduce((n, x) => n + x.reopened, 0),
				userComments: 3,
				granaryComments: closedTotal,
				deliveries: Math.round(total * 1.3),
				deliveryFailures: 0,
				rawDeliveries: 4,
				faultsInjected: s.summary.state === 'running' ? 3 : 0,
				redeliveries: 2,
				personaActions: total * 2,
				personaErrors: 0,
				latency: { count: latencies.length, p50: pct(50), p95: pct(95), p99: pct(99), max: latencies.at(-1) ?? null },
				throughputPerMin: Math.round((total / Math.max(1 / 60, elapsed / 60_000)) * 10) / 10
			},
			series,
			invariants: (Object.keys(INVARIANTS) as InvariantId[]).map((inv) => ({
				id: inv,
				...INVARIANTS[inv],
				status: violatedBy.has(inv) ? 'violated' : finalized ? 'ok' : inv === 'eventually-closed' ? 'pending' : 'ok',
				violations: s.violations.filter((v) => v.invariant === inv).length,
				checked: inv === 'webhooks-healthy' ? Math.round(total * 1.3) : issues.length
			})),
			violations: s.violations,
			personaCounts: PERSONA_KINDS.filter((k) => counts.has(k)).map((k) => counts.get(k)!),
			plan: personas.map((p, index) => ({ index, atMs: index * 1500, kind: p.summary.kind, personaId: p.summary.id })),
			log: s.log
		};
	}

	createScenario(req: CreateScenarioRequest): ScenarioSummary {
		const base = req.preset ? PRESETS[req.preset].config : DEFAULT_CONFIG;
		const config = { ...base, ...(req.config ?? {}) } as ScenarioConfig;
		const id = `stub${++this.#counter}`;
		const now = Date.now();
		this.#scenarios.set(id, {
			summary: {
				id,
				name: config.name,
				preset: req.preset ?? null,
				state: req.start ? 'running' : 'created',
				seed: config.seed,
				repo: { owner: 'loadgen', name: `load-${id}`, id: null },
				createdAt: now,
				startedAt: req.start ? now : null,
				endedAt: null,
				elapsedMs: 0,
				personasPlanned: config.personas,
				personasArrived: 0,
				personasActive: 0,
				issuesOpened: 0,
				violations: 0,
				faultsActive: false
			},
			config,
			violations: [],
			log: [{ at: now, text: `created: ${config.personas} personas planned (stub — nothing will arrive).` }],
			startedMs: now
		});
		return this.#summary(this.#scenarios.get(id)!);
	}

	control(id: string, action: ScenarioAction): ScenarioSummary {
		const s = this.#get(id);
		const st = s.summary.state;
		const next: Partial<Record<ScenarioAction, ScenarioState>> =
			action === 'start' && st === 'created'
				? { start: 'running' }
				: action === 'pause' && st === 'running'
					? { pause: 'paused' }
					: action === 'resume' && st === 'paused'
						? { resume: 'running' }
						: action === 'stop' && !TERMINAL.includes(st)
							? { stop: 'stopped' }
							: {};
		const to = next[action];
		if (!to) throw new BackendError('conflict', `Scenario ${id} is ${st}; cannot ${action}.`);
		s.summary = { ...s.summary, state: to, startedAt: s.summary.startedAt ?? Date.now(), endedAt: TERMINAL.includes(to) ? Date.now() : null };
		s.log.unshift({ at: Date.now(), text: `${to}: (stub)` });
		return this.#summary(s);
	}

	listPersonas(q: ListPersonasQuery): PersonaSummary[] {
		return [...this.#personas.values()]
			.filter((p) => (!q.scenarioId || p.summary.scenarioId === q.scenarioId) && (!q.kind || p.summary.kind === q.kind))
			.map((p) => p.summary);
	}

	getPersona(kind: PersonaKind, name: string): PersonaDetail {
		const p = this.#personas.get(`${kind}/${name}`);
		if (!p) throw new BackendError('not-found', `Unknown persona ${kind}/${name}`);
		const spec = PERSONAS[kind];
		return {
			summary: p.summary,
			data: p.data,
			chart: toChart(spec.chart().build(), kind, 'v1', `loadgen/personas/${kind}.ts`),
			timeline: p.timeline,
			issues: p.issues,
			kindInfo: { title: spec.title, description: spec.description, expected: spec.expected }
		};
	}

	kinds(): PersonaKindInfo[] {
		return PERSONA_KINDS.map((k) => ({
			kind: k,
			title: PERSONAS[k].title,
			description: PERSONAS[k].description,
			expected: PERSONAS[k].expected,
			chart: toChart(PERSONAS[k].chart().build(), k, 'v1', `loadgen/personas/${k}.ts`)
		}));
	}

	reset() {
		this.#scenarios.clear();
		this.#personas.clear();
	}

	get bornAt() {
		return this.#born;
	}
}
