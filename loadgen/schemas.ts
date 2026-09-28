/**
 * Load generator HTTP API and data shapes (ADR 0070–0074).
 *
 * Shared by `loadgen/server.ts`, `loadgen/cli.ts` and the app's dev backend
 * (`src/lib/schemas/dev.ts` re-exports these). Relative imports only, so it
 * loads under plain Bun and inside SvelteKit.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { ChartStructure } from '../src/lib/schemas/api';
import { Nullable } from '../src/lib/schemas/github';
import { parse } from '../src/lib/schemas/standard';

const closed = { additionalProperties: false } as const;

// ---------------------------------------------------------------------------
// Persona kinds
// ---------------------------------------------------------------------------

export const PERSONA_KINDS = [
	'slop-fixer',
	'persistent-contributor',
	'regular',
	'maintainer',
	'member',
	'first-timer',
	'bot',
	'chaos-monkey',
	'fuzzer'
] as const;
export const PersonaKind = Type.Union(PERSONA_KINDS.map((k) => Type.Literal(k)));
export type PersonaKind = (typeof PERSONA_KINDS)[number];

/** What granary should do with a persona's issues (ADR 0071). */
export const ExpectedOutcome = Type.Union([
	Type.Literal('open'),
	Type.Literal('closed'),
	Type.Literal('varies'),
	Type.Literal('none')
]);
export type ExpectedOutcome = Static<typeof ExpectedOutcome>;

// ---------------------------------------------------------------------------
// Scenarios (ADR 0072)
// ---------------------------------------------------------------------------

export const PRESET_NAMES = ['smoke', 'steady', 'slop-storm', 'bot-flood', 'chaos', 'fuzz'] as const;
export const PresetName = Type.Union(PRESET_NAMES.map((k) => Type.Literal(k)));
export type PresetName = (typeof PRESET_NAMES)[number];

const MixWeight = Type.Optional(Type.Number({ minimum: 0, maximum: 100 }));
export const PersonaMix = Type.Object(
	Object.fromEntries(PERSONA_KINDS.map((k) => [k, MixWeight])) as Record<PersonaKind, typeof MixWeight>,
	closed
);
export type PersonaMix = Partial<Record<PersonaKind, number>>;

export const ScenarioConfig = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 60 }),
		seed: Type.Integer({ minimum: 0, maximum: 4294967295 }),
		mix: PersonaMix,
		/** Total personas that arrive. */
		personas: Type.Integer({ minimum: 1, maximum: 500 }),
		arrivalRatePerMin: Type.Number({ minimum: 1, maximum: 1200 }),
		rampUpMs: Type.Integer({ minimum: 0, maximum: 3_600_000 }),
		durationMs: Type.Integer({ minimum: 1000, maximum: 3_600_000 }),
		/** Multiplier on persona think-times (1 = human-ish, 0.1 = 10× faster). */
		timeScale: Type.Number({ minimum: 0.01, maximum: 5 }),
		/** `eventually-closed` budget per issue (ADR 0073). */
		closeDeadlineMs: Type.Integer({ minimum: 1000, maximum: 600_000 }),
		/** Extra budget when chaos injected faults. */
		faultGraceMs: Type.Integer({ minimum: 0, maximum: 600_000 })
	},
	closed
);
export type ScenarioConfig = Static<typeof ScenarioConfig>;

export const ScenarioConfigPatch = Type.Partial(ScenarioConfig, closed);
export type ScenarioConfigPatch = Static<typeof ScenarioConfigPatch>;

export const CreateScenarioRequest = Type.Object(
	{
		preset: Type.Optional(PresetName),
		config: Type.Optional(ScenarioConfigPatch),
		/** Start immediately. */
		start: Type.Optional(Type.Boolean())
	},
	closed
);
export type CreateScenarioRequest = Static<typeof CreateScenarioRequest>;

export const ScenarioAction = Type.Union([
	Type.Literal('start'),
	Type.Literal('pause'),
	Type.Literal('resume'),
	Type.Literal('stop')
]);
export type ScenarioAction = Static<typeof ScenarioAction>;

export const SCENARIO_STATES = ['created', 'running', 'paused', 'draining', 'settling', 'finished', 'stopped'] as const;
export const ScenarioState = Type.Union(SCENARIO_STATES.map((k) => Type.Literal(k)));
export type ScenarioState = (typeof SCENARIO_STATES)[number];

export const PresetInfo = Type.Object(
	{ name: PresetName, description: Type.String(), config: ScenarioConfig },
	closed
);
export type PresetInfo = Static<typeof PresetInfo>;

export const ScenarioSummary = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		preset: Nullable(PresetName),
		state: ScenarioState,
		seed: Type.Integer(),
		repo: Type.Object({ owner: Type.String(), name: Type.String(), id: Nullable(Type.Integer()) }, closed),
		createdAt: Type.Integer(),
		startedAt: Nullable(Type.Integer()),
		endedAt: Nullable(Type.Integer()),
		/** Active (unpaused) running time so far. */
		elapsedMs: Type.Integer(),
		personasPlanned: Type.Integer(),
		personasArrived: Type.Integer(),
		personasActive: Type.Integer(),
		issuesOpened: Type.Integer(),
		violations: Type.Integer(),
		faultsActive: Type.Boolean()
	},
	closed
);
export type ScenarioSummary = Static<typeof ScenarioSummary>;

export const LatencyStats = Type.Object(
	{
		count: Type.Integer(),
		p50: Nullable(Type.Number()),
		p95: Nullable(Type.Number()),
		p99: Nullable(Type.Number()),
		max: Nullable(Type.Number())
	},
	closed
);
export type LatencyStats = Static<typeof LatencyStats>;

export const Metrics = Type.Object(
	{
		issuesOpened: Type.Integer(),
		expectedOpen: Type.Integer(),
		expectedClosed: Type.Integer(),
		closedByGranary: Type.Integer(),
		/** Expected open and still open. */
		allowedOpen: Type.Integer(),
		/** Expected closed, still open, within deadline. */
		pendingClose: Type.Integer(),
		overdue: Type.Integer(),
		reopenedByUsers: Type.Integer(),
		userComments: Type.Integer(),
		granaryComments: Type.Integer(),
		deliveries: Type.Integer(),
		deliveryFailures: Type.Integer(),
		rawDeliveries: Type.Integer(),
		faultsInjected: Type.Integer(),
		redeliveries: Type.Integer(),
		personaActions: Type.Integer(),
		personaErrors: Type.Integer(),
		latency: LatencyStats,
		/** Issues opened per minute over active time. */
		throughputPerMin: Type.Number()
	},
	closed
);
export type Metrics = Static<typeof Metrics>;

/** One per-second sample; `t` is seconds since start. Values are cumulative except `backlog`/`p95`. */
export const SeriesPoint = Type.Object(
	{
		t: Type.Number(),
		opened: Type.Integer(),
		closed: Type.Integer(),
		backlog: Type.Integer(),
		p95: Nullable(Type.Number()),
		deliveries: Type.Integer(),
		errors: Type.Integer(),
		activePersonas: Type.Integer()
	},
	closed
);
export type SeriesPoint = Static<typeof SeriesPoint>;

export const INVARIANT_IDS = [
	'allowed-stay-open',
	'single-comment',
	'close-once',
	'eventually-closed',
	'webhooks-healthy'
] as const;
export const InvariantId = Type.Union(INVARIANT_IDS.map((k) => Type.Literal(k)));
export type InvariantId = (typeof INVARIANT_IDS)[number];

export const InvariantStatus = Type.Object(
	{
		id: InvariantId,
		title: Type.String(),
		description: Type.String(),
		status: Type.Union([Type.Literal('ok'), Type.Literal('violated'), Type.Literal('pending')]),
		violations: Type.Integer(),
		/** How many issues / deliveries it has judged. */
		checked: Type.Integer()
	},
	closed
);
export type InvariantStatus = Static<typeof InvariantStatus>;

export const IssueEventType = Type.Union([
	Type.Literal('opened'),
	Type.Literal('closed'),
	Type.Literal('reopened'),
	Type.Literal('comment'),
	Type.Literal('delivery')
]);

/** One line of an issue's timeline in the ledger. */
export const IssueTimelineEntry = Type.Object(
	{
		at: Type.Integer(),
		type: IssueEventType,
		by: Nullable(Type.String()),
		detail: Type.String()
	},
	closed
);
export type IssueTimelineEntry = Static<typeof IssueTimelineEntry>;

export const PersonaRef = Type.Object(
	{ id: Type.String(), kind: PersonaKind, name: Type.String(), login: Type.String() },
	closed
);
export type PersonaRef = Static<typeof PersonaRef>;

export const IssueRef = Type.Object(
	{
		number: Type.Integer(),
		repoId: Type.Integer(),
		/** granary's issue key `<repoId>-<number>`. */
		issueKey: Type.String(),
		htmlUrl: Type.String(),
		title: Type.String()
	},
	closed
);
export type IssueRef = Static<typeof IssueRef>;

export const Violation = Type.Object(
	{
		id: Type.String(),
		invariant: InvariantId,
		at: Type.Integer(),
		message: Type.String(),
		persona: Nullable(PersonaRef),
		issue: Nullable(IssueRef),
		timeline: Type.Array(IssueTimelineEntry)
	},
	closed
);
export type Violation = Static<typeof Violation>;

export const PersonaKindCount = Type.Object(
	{
		kind: PersonaKind,
		arrived: Type.Integer(),
		active: Type.Integer(),
		/** Leaf state → number of personas currently in it. */
		states: Type.Record(Type.String(), Type.Integer())
	},
	closed
);
export type PersonaKindCount = Static<typeof PersonaKindCount>;

export const PlannedArrival = Type.Object(
	{ index: Type.Integer(), atMs: Type.Integer(), kind: PersonaKind, personaId: Nullable(Type.String()) },
	closed
);
export type PlannedArrival = Static<typeof PlannedArrival>;

export const ScenarioDetail = Type.Object(
	{
		summary: ScenarioSummary,
		config: ScenarioConfig,
		metrics: Metrics,
		series: Type.Array(SeriesPoint),
		invariants: Type.Array(InvariantStatus),
		/** Newest first, at most 200. */
		violations: Type.Array(Violation),
		personaCounts: Type.Array(PersonaKindCount),
		/** First 500 planned arrivals. */
		plan: Type.Array(PlannedArrival),
		/** The scenario coordinator's narration, newest first. */
		log: Type.Array(Type.Object({ at: Type.Integer(), text: Type.String() }, closed))
	},
	closed
);
export type ScenarioDetail = Static<typeof ScenarioDetail>;

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export const TimelineKind = Type.Union([
	Type.Literal('narration'),
	Type.Literal('action'),
	Type.Literal('result'),
	Type.Literal('notification'),
	Type.Literal('error')
]);
export type TimelineKind = Static<typeof TimelineKind>;

export const TimelineEntry = Type.Object(
	{
		at: Type.Integer(),
		kind: TimelineKind,
		/** Leaf state when it happened (narrations), else null. */
		state: Nullable(Type.String()),
		text: Type.String(),
		issueNumber: Nullable(Type.Integer())
	},
	closed
);
export type TimelineEntry = Static<typeof TimelineEntry>;

export const PersonaIssue = Type.Object(
	{
		...IssueRef.properties,
		expected: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
		state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
		closedBy: Nullable(Type.String()),
		/** open → first granary close. */
		latencyMs: Nullable(Type.Integer()),
		granaryComments: Type.Integer(),
		reopened: Type.Integer(),
		/** Matches `expected` (or still within deadline). */
		outcome: Type.Union([Type.Literal('as-expected'), Type.Literal('pending'), Type.Literal('violation')]),
		timeline: Type.Array(IssueTimelineEntry)
	},
	closed
);
export type PersonaIssue = Static<typeof PersonaIssue>;

export const PersonaSummary = Type.Object(
	{
		id: Type.String(),
		kind: PersonaKind,
		name: Type.String(),
		login: Type.String(),
		scenarioId: Type.String(),
		arrivedAt: Type.Integer(),
		/** Leaf states (without the root). */
		activeStates: Type.Array(Type.String()),
		finished: Type.Boolean(),
		finalState: Nullable(Type.String()),
		/** Resident in the system (false once stopped/destroyed: a frozen snapshot is shown). */
		live: Type.Boolean(),
		issuesOpened: Type.Integer(),
		issuesClosed: Type.Integer(),
		actions: Type.Integer(),
		errors: Type.Integer(),
		lastNote: Type.String(),
		lastActivityAt: Type.Integer(),
		violations: Type.Integer()
	},
	closed
);
export type PersonaSummary = Static<typeof PersonaSummary>;

export const PersonaDetail = Type.Object(
	{
		summary: PersonaSummary,
		/** JSON-safe copy of the persona's data model. */
		data: Type.Unknown(),
		/** ChartStructure (src/lib/schemas/api.ts); kept loose here. */
		chart: Type.Unknown(),
		timeline: Type.Array(TimelineEntry),
		issues: Type.Array(PersonaIssue),
		kindInfo: Type.Object(
			{ title: Type.String(), description: Type.String(), expected: ExpectedOutcome },
			closed
		)
	},
	closed
);
export type PersonaDetail = Omit<Static<typeof PersonaDetail>, 'chart'> & { chart: ChartStructure | null };

export const PersonaKindInfo = Type.Object(
	{
		kind: PersonaKind,
		title: Type.String(),
		description: Type.String(),
		expected: ExpectedOutcome,
		chart: Type.Unknown()
	},
	closed
);
export type PersonaKindInfo = Omit<Static<typeof PersonaKindInfo>, 'chart'> & { chart: ChartStructure | null };

export const ListPersonasQuery = Type.Object(
	{
		scenarioId: Type.Optional(Type.String({ minLength: 1 })),
		kind: Type.Optional(PersonaKind)
	},
	closed
);
export type ListPersonasQuery = Static<typeof ListPersonasQuery>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const LoadgenStatus = Type.Object(
	{
		ok: Type.Literal(true),
		fakeGithubUrl: Type.String(),
		eventStream: Type.Object(
			{ connected: Type.Boolean(), lastSeq: Type.Integer(), error: Nullable(Type.String()) },
			closed
		),
		activeScenarioId: Nullable(Type.String()),
		scenarios: Type.Integer(),
		allowlisted: Type.Array(Type.String()),
		granaryLogin: Type.String(),
		presets: Type.Array(PresetInfo)
	},
	closed
);
export type LoadgenStatus = Static<typeof LoadgenStatus>;

export const LoadgenError = Type.Object(
	{
		error: Type.String(),
		issues: Type.Optional(
			Type.Array(Type.Object({ message: Type.String(), path: Type.Array(Type.Union([Type.String(), Type.Number()])) }))
		)
	},
	closed
);
export type LoadgenError = Static<typeof LoadgenError>;

/** API paths (all JSON). */
export const LOADGEN_PATHS = {
	status: '/api/status',
	presets: '/api/presets',
	kinds: '/api/kinds',
	scenarios: '/api/scenarios',
	scenario: (id: string) => `/api/scenarios/${encodeURIComponent(id)}`,
	control: (id: string, action: ScenarioAction) => `/api/scenarios/${encodeURIComponent(id)}/${action}`,
	personas: '/api/personas',
	persona: (kind: string, name: string) => `/api/personas/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
	reset: '/api/reset'
} as const;

export const parseWith = <S extends TSchema>(schema: S, value: unknown, what: string): Static<S> =>
	parse(schema, value, what);
