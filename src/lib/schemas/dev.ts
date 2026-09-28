/**
 * DTOs of the dev-only remote functions (`/__dev`, ADR 0009, ADR 0031).
 * Fake GitHub control shapes are re-used from `fake-github/schemas.ts`.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
	CreateIssueRequest,
	InjectFaultRequest,
	ReopenIssueRequest,
	type FakeState,
	type InjectFaultResponse,
	type RedeliverResponse,
	type ReopenIssueResponse
} from '../../../fake-github/schemas';
import { ActorAddress } from './actors';
import { Login } from './github';

const closed = { additionalProperties: false } as const;

// ---------------------------------------------------------------------------
// getDevInfo
// ---------------------------------------------------------------------------

export interface DevInfo {
	/** DAP TCP server: host is always 127.0.0.1. */
	dapHost: string;
	dapPort: number;
	/** Base URL of the fake GitHub (GITHUB_API_URL in dev). */
	fakeGithubUrl: string;
	/** Logins from `ADMINS`, for one-click "log in as admin". */
	admins: string[];
	fakeGithub: {
		/** false when `GET /__control/state` failed (fake not running). */
		reachable: boolean;
		error: string | null;
		state: FakeState | null;
		/** Logins of `state.users` (empty when unreachable). */
		users: string[];
	};
}

// ---------------------------------------------------------------------------
// devLoginAs (form)
// ---------------------------------------------------------------------------

export const DevLoginAsInput = Type.Object(
	{
		login: Login,
		/** Same-origin path to go to afterwards; default `/`. */
		redirectTo: Type.Optional(Type.String({ pattern: '^/(?!/)' }))
	},
	closed
);
export type DevLoginAsInput = Static<typeof DevLoginAsInput>;

// ---------------------------------------------------------------------------
// Fake GitHub actions
// ---------------------------------------------------------------------------

/** `devOpenIssue` form fields — the fake's `POST /__control/issues` body. */
export const DevOpenIssueInput = CreateIssueRequest;
export type DevOpenIssueInput = Static<typeof DevOpenIssueInput>;

export interface DevOpenIssueResult {
	number: number;
	deliveryId: string;
	/** repository.id from the fake (via `POST /__control/repos`). */
	repoId: number;
	issueKey: string;
}

/** `devReopenIssue` command input — `POST /__control/issues/reopen` body. */
export const DevReopenIssueInput = ReopenIssueRequest;
export type DevReopenIssueInput = Static<typeof DevReopenIssueInput>;
export type DevReopenIssueResult = ReopenIssueResponse;

export const DevRedeliverInput = Type.Object({ deliveryId: Type.String({ minLength: 1 }) }, closed);
export type DevRedeliverInput = Static<typeof DevRedeliverInput>;
export type DevRedeliverResult = RedeliverResponse;

/** `devInjectFault` form fields — `POST /__control/faults` body (use `.as('number')` for numbers). */
export const DevInjectFaultInput = InjectFaultRequest;
export type DevInjectFaultInput = Static<typeof DevInjectFaultInput>;
export type DevInjectFaultResult = InjectFaultResponse;

// ---------------------------------------------------------------------------
// devSendEvent (command)
// ---------------------------------------------------------------------------

export const DevSendEventInput = Type.Object(
	{
		address: ActorAddress,
		event: Type.String({ minLength: 1, maxLength: 200 }),
		/** JSON text; parsed server-side. Omitted or '' = no data. */
		data: Type.Optional(Type.String({ maxLength: 65536 }))
	},
	closed
);
export type DevSendEventInput = Static<typeof DevSendEventInput>;

/** What the Backend receives (data already JSON-parsed; `undefined` = none). */
export interface DevSendEvent {
	address: ActorAddress;
	event: string;
	data: unknown;
}

export interface DevSendEventResult {
	/** `SendResult.status` of `system.send(address, event, data, {until:'completed'})`. */
	status: 'accepted' | 'stable' | 'done';
	/** Active states after the macrostep, or null if the actor is gone. */
	activeStates: string[] | null;
}

// ---------------------------------------------------------------------------
// getRecentSpans (query)
// ---------------------------------------------------------------------------

/** Spans the dev ring buffer keeps (ADR 0054). */
export const SPAN_BUFFER_SIZE = 2000;

export const GetRecentSpansInput = Type.Object(
	{
		/** Default 100, max SPAN_BUFFER_SIZE (pass it with `traceId` to get a whole trace). */
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SPAN_BUFFER_SIZE })),
		/** Keep only spans of actors of this family. */
		family: Type.Optional(Type.String({ minLength: 1 })),
		traceId: Type.Optional(Type.String({ pattern: '^[0-9a-f]{32}$' }))
	},
	closed
);
export type GetRecentSpansInput = Static<typeof GetRecentSpansInput>;

export type SpanAttributeValue = string | number | boolean | null;

/** A decoded span (tinyactors `DecodedSpan`), simplified. Newest first. */
export interface SpanSummary {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
	/** Epoch ms. */
	start: number;
	end: number;
	durationMs: number;
	/** Non-primitive attribute values are JSON-stringified. */
	attributes: Record<string, SpanAttributeValue>;
	status: { code: 'unset' | 'ok' | 'error'; message: string | null };
	events: { name: string; time: number; attributes: Record<string, SpanAttributeValue> }[];
	/** Resource `service.name`, or null. */
	service: string | null;
	/** OTLP span links (e.g. tinyactors `parent: 'link'` causes). */
	links: { traceId: string; spanId: string; attributes: Record<string, SpanAttributeValue> }[];
	/**
	 * The step that caused this span (`scxml.cause.*` → `stepSpanID`), or null.
	 * `traceId` is the trace holding that span when it is still in the buffer.
	 */
	cause: { spanId: string; traceId: string | null } | null;
}

// ---------------------------------------------------------------------------
// listRecentTraces (query) — spans of the buffer grouped by trace (ADR 0054)
// ---------------------------------------------------------------------------

export const ListRecentTracesInput = Type.Object(
	{
		/** Default 50, max 200. */
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		/** Keep traces with at least one span of an actor of this family. */
		family: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		/** Keep traces touching an actor whose address contains this (case-insensitive). */
		address: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		/** Keep traces with a span or event name containing this (case-insensitive). */
		search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))
	},
	closed
);
export type ListRecentTracesInput = Static<typeof ListRecentTracesInput>;

/** One trace in the buffer, summarised. Newest (by start) first. */
export interface TraceSummary {
	traceId: string;
	/** The earliest span without a parent in the buffer, or null. */
	rootSpanId: string | null;
	rootName: string;
	/** The root's actor address, if any. */
	rootAddress: string | null;
	services: string[];
	/** Actor addresses touched, in first-seen order. */
	addresses: string[];
	families: string[];
	/** Distinct `scxml.event.name` values, in first-seen order. */
	events: string[];
	spanCount: number;
	errorCount: number;
	/** Spans naming a parent that is not in the buffer. */
	orphanCount: number;
	/** Epoch ms. */
	start: number;
	end: number;
	durationMs: number;
	/** Other traces referenced through span links. */
	linkedTraceIds: string[];
}

// ---------------------------------------------------------------------------
// getDapLaunchConfig (query)
// ---------------------------------------------------------------------------

export const GetDapLaunchConfigInput = Type.Object({ address: ActorAddress }, closed);
export type GetDapLaunchConfigInput = Static<typeof GetDapLaunchConfigInput>;

/** A VS Code `launch.json` configuration for tinyactors-vscode (ADR 0009). */
export interface DapLaunchConfig {
	type: 'tinyactors';
	request: 'attach';
	/** e.g. `granary: issue/123-4` */
	name: string;
	port: number;
	/** `family/name` */
	address: string;
}

// ---------------------------------------------------------------------------
// Load generator (ADR 0070–0076). Shapes come from `loadgen/schemas.ts`.
// ---------------------------------------------------------------------------

import {
	CreateScenarioRequest,
	ListPersonasQuery,
	PersonaKind,
	ScenarioAction,
	type LoadgenStatus,
	type PersonaDetail,
	type PersonaKindInfo,
	type PersonaSummary,
	type ScenarioDetail,
	type ScenarioSummary
} from '../../../loadgen/schemas';

export {
	CreateScenarioRequest,
	ListPersonasQuery,
	type LoadgenStatus,
	type PersonaDetail,
	type PersonaKindInfo,
	type PersonaSummary,
	type ScenarioDetail,
	type ScenarioSummary
};
export type {
	InvariantStatus,
	Metrics,
	PersonaIssue,
	PersonaKind,
	PersonaKindCount,
	PresetInfo,
	PresetName,
	ScenarioAction,
	ScenarioConfig,
	ScenarioState,
	SeriesPoint,
	TimelineEntry,
	Violation
} from '../../../loadgen/schemas';
export { PERSONA_KINDS, PRESET_NAMES, SCENARIO_STATES } from '../../../loadgen/schemas';

/** `getLoadgenStatus`: reachability plus the loadgen's own status. */
export interface LoadgenInfo {
	url: string;
	reachable: boolean;
	error: string | null;
	status: LoadgenStatus | null;
}

export const ScenarioIdInput = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, closed);
export type ScenarioIdInput = Static<typeof ScenarioIdInput>;

export const ControlScenarioInput = Type.Object(
	{ id: Type.String({ minLength: 1, maxLength: 64 }), action: ScenarioAction },
	closed
);
export type ControlScenarioInput = Static<typeof ControlScenarioInput>;

export const GetPersonaInput = Type.Object(
	{ kind: PersonaKind, name: Type.String({ minLength: 1, maxLength: 64 }) },
	closed
);
export type GetPersonaInput = Static<typeof GetPersonaInput>;

// ---------------------------------------------------------------------------
// fake-infra (ADR 0130–0139). Shapes come from `fake-infra/schemas.ts`.
// ---------------------------------------------------------------------------

import {
	ClockRequest as FakeInfraClockRequest,
	CreateBucketRequest as FakeInfraCreateBucketRequest,
	ExeProxyRequest as FakeInfraExeProxyRequest,
	FidelityRequest as FakeInfraFidelityRequest,
	InjectFaultRequest as FakeInfraInjectFaultRequest,
	IssueCredentialRequest as FakeInfraIssueCredentialRequest,
	IssuedCredential as FakeInfraIssuedCredential,
	FakeInfraState
} from '../../../fake-infra/schemas';
export { FakeInfraState as FakeInfraStateSchema };
export type FakeInfraStateValue = Static<typeof FakeInfraState>;
export type FakeInfraIssued = Static<typeof FakeInfraIssuedCredential>;

/** `getFakeInfraStatus`: reachability plus the fake's full state (never throws when it is down). */
export interface FakeInfraInfo {
	url: string;
	reachable: boolean;
	error: string | null;
	state: FakeInfraStateValue | null;
	/** Where the exe.dev proxy fronts listen, as URLs (null when off/unknown). */
	exeTokenUrl: string | null;
	exePeerUrl: string | null;
}

/** One control action on the fake (the dev portal's buttons and forms). */
export const FakeInfraAction = Type.Union([
	Type.Object({ action: Type.Literal('reset') }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('create-bucket'), bucket: FakeInfraCreateBucketRequest }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('delete-bucket'), name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('issue-credential'), credential: FakeInfraIssueCredentialRequest }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('revoke-credential'), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('inject-fault'), fault: FakeInfraInjectFaultRequest }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('clear-faults') }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('set-fidelity'), fidelity: Type.Partial(FakeInfraFidelityRequest) }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('set-clock'), clock: FakeInfraClockRequest }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal('set-exe-proxy'), proxy: FakeInfraExeProxyRequest }, { additionalProperties: false })
]);
export type FakeInfraAction = Static<typeof FakeInfraAction>;

export interface FakeInfraActionResult {
	ok: true;
	/** `issue-credential`: the secret material, shown once. */
	issued?: FakeInfraIssued;
	/** `inject-fault`: the new fault's id. */
	faultId?: string;
}
