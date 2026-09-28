/**
 * HTTP client for fake-infra's control API (ADR 0130, 0139), used by the real
 * backend's dev methods. Responses are validated with `fake-infra/schemas.ts`;
 * failures become `BackendError`s.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { CONTROL_PATHS, FakeInfraState, InjectFaultResponse, IssuedCredential } from '../../../fake-infra/schemas';
import type { FakeInfraAction, FakeInfraActionResult, FakeInfraInfo } from '../schemas/dev';
import { parse, SchemaValidationError } from '../schemas/standard';
import { BackendError } from './backend';

export class FakeInfraClient {
	constructor(readonly base: string) {}

	async #call(method: string, path: string, body?: unknown): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method,
				headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(10_000)
			});
		} catch (e) {
			throw new BackendError('unavailable', `fake-infra unreachable at ${this.base}: ${(e as Error).message} (mise run fake-infra)`);
		}
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			const j = json as { error?: string; details?: string[] } | null;
			const message = [j?.error ?? (text.slice(0, 200) || `HTTP ${res.status}`), ...(j?.details ?? [])].join('; ');
			if (res.status === 404) throw new BackendError('not-found', message);
			if (res.status === 400) throw new BackendError('invalid', message);
			if (res.status === 409) throw new BackendError('conflict', message);
			throw new BackendError('upstream', `${method} ${path} → ${res.status}: ${message}`);
		}
		return json;
	}

	#parse<S extends TSchema>(schema: S, value: unknown, what: string): Static<S> {
		try {
			return parse(schema, value, `fake-infra ${what}`);
		} catch (e) {
			if (e instanceof SchemaValidationError) throw new BackendError('upstream', e.message);
			throw e;
		}
	}

	async info(): Promise<FakeInfraInfo> {
		try {
			const state = this.#parse(FakeInfraState, await this.#call('GET', CONTROL_PATHS.state), 'state');
			const host = new URL(this.base).hostname;
			const url = (port: number | null) => (port === null ? null : `http://${host}:${port}`);
			return { url: this.base, reachable: true, error: null, state, exeTokenUrl: url(state.exeProxy.tokenPort), exePeerUrl: url(state.exeProxy.peerPort) };
		} catch (e) {
			return { url: this.base, reachable: false, error: (e as Error).message, state: null, exeTokenUrl: null, exePeerUrl: null };
		}
	}

	async control(a: FakeInfraAction): Promise<FakeInfraActionResult> {
		const P = CONTROL_PATHS;
		switch (a.action) {
			case 'reset':
				await this.#call('POST', P.reset);
				return { ok: true };
			case 'create-bucket':
				await this.#call('POST', P.buckets, a.bucket);
				return { ok: true };
			case 'delete-bucket':
				await this.#call('DELETE', `${P.buckets}/${encodeURIComponent(a.name)}`);
				return { ok: true };
			case 'issue-credential':
				return { ok: true, issued: this.#parse(IssuedCredential, await this.#call('POST', P.credentials, a.credential), 'credential') };
			case 'revoke-credential':
				await this.#call('DELETE', `${P.credentials}/${encodeURIComponent(a.id)}`);
				return { ok: true };
			case 'inject-fault':
				return { ok: true, faultId: this.#parse(InjectFaultResponse, await this.#call('POST', P.faults, a.fault), 'fault').id };
			case 'clear-faults':
				await this.#call('DELETE', P.faults);
				return { ok: true };
			case 'set-fidelity':
				await this.#call('PUT', P.fidelity, a.fidelity);
				return { ok: true };
			case 'set-clock':
				await this.#call('PUT', P.clock, a.clock);
				return { ok: true };
			case 'set-exe-proxy':
				await this.#call('PUT', P.exeProxy, a.proxy);
				return { ok: true };
		}
	}
}
