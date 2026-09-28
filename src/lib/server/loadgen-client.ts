/**
 * HTTP client for the load generator API (ADR 0070, 0076), used by the real
 * backend. Responses are validated with the TypeBox schemas in
 * `loadgen/schemas.ts`; failures become `BackendError`s.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
	LOADGEN_PATHS,
	LoadgenStatus,
	PersonaDetail,
	PersonaKindInfo,
	PersonaSummary,
	ScenarioDetail,
	ScenarioSummary,
	type CreateScenarioRequest,
	type ListPersonasQuery,
	type PersonaKind,
	type ScenarioAction
} from '../../../loadgen/schemas';
import type { LoadgenInfo } from '../schemas/dev';
import { parse, SchemaValidationError } from '../schemas/standard';
import { BackendError } from './backend';

type Detail = import('../../../loadgen/schemas').PersonaDetail;
type KindInfo = import('../../../loadgen/schemas').PersonaKindInfo;

export class LoadgenClient {
	constructor(readonly base: string) {}

	async #call<S extends TSchema>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<Static<S>> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method,
				headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(15_000)
			});
		} catch (e) {
			throw new BackendError('unavailable', `Load generator unreachable at ${this.base}: ${(e as Error).message} (mise run loadgen)`);
		}
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			const message = (json as { error?: string } | null)?.error ?? (text.slice(0, 200) || `HTTP ${res.status}`);
			if (res.status === 404) throw new BackendError('not-found', message);
			if (res.status === 400) throw new BackendError('invalid', message);
			if (res.status === 409) throw new BackendError('conflict', message);
			throw new BackendError('upstream', `${method} ${path} → ${res.status}: ${message}`);
		}
		try {
			return parse(schema, json, `loadgen ${path}`);
		} catch (e) {
			if (e instanceof SchemaValidationError) throw new BackendError('upstream', e.message);
			throw e;
		}
	}

	async info(): Promise<LoadgenInfo> {
		try {
			const status = await this.#call('GET', LOADGEN_PATHS.status, LoadgenStatus);
			return { url: this.base, reachable: true, error: null, status };
		} catch (e) {
			return { url: this.base, reachable: false, error: (e as Error).message, status: null };
		}
	}
	listScenarios() {
		return this.#call('GET', LOADGEN_PATHS.scenarios, Type.Array(ScenarioSummary));
	}
	getScenario(id: string) {
		return this.#call('GET', LOADGEN_PATHS.scenario(id), ScenarioDetail);
	}
	createScenario(req: CreateScenarioRequest) {
		return this.#call('POST', LOADGEN_PATHS.scenarios, ScenarioSummary, req);
	}
	control(id: string, action: ScenarioAction) {
		return this.#call('POST', LOADGEN_PATHS.control(id, action), ScenarioSummary, {});
	}
	listPersonas(q: ListPersonasQuery) {
		const params = new URLSearchParams();
		if (q.scenarioId) params.set('scenarioId', q.scenarioId);
		if (q.kind) params.set('kind', q.kind);
		const qs = params.toString();
		return this.#call('GET', `${LOADGEN_PATHS.personas}${qs ? `?${qs}` : ''}`, Type.Array(PersonaSummary));
	}
	async getPersona(kind: PersonaKind, name: string): Promise<Detail> {
		return (await this.#call('GET', LOADGEN_PATHS.persona(kind, name), PersonaDetail)) as Detail;
	}
	async kinds(): Promise<KindInfo[]> {
		return (await this.#call('GET', LOADGEN_PATHS.kinds, Type.Array(PersonaKindInfo))) as KindInfo[];
	}
	async reset(): Promise<void> {
		await this.#call('POST', LOADGEN_PATHS.reset, Type.Object({ ok: Type.Literal(true) }), {});
	}
}
