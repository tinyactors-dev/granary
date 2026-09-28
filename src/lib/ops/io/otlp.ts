/**
 * `otlp` I/O processor (ADR 0082, 0085, 0099, 0121): POSTs a sink's queued
 * batches as OTLP/HTTP and replies `sink.sent` / `sink.failed` to the
 * telemetry-sink actor. Secrets (sink tokens) are revealed here, at the
 * moment of use, and never enter actor data (ADR 0086).
 *
 * Also exports `testSinkConnection` for the OpsBackend's test connection.
 */
import type { EffectContext, IOProcessor, IORequest } from '@tinyactors/node';
import type { OpsLogger, TestConnectionResult, TestStep } from '../contract';
import type { Redactor, SecretReader } from '../feature';
import { EXE_AUTH_HEADER, type SinkAuth, type TelemetrySignal } from '../schemas/sinks';
import type { SinksRepo } from '../telemetry/sinks-repo';

export const OTLP_IO_TYPE = 'otlp';
/** Event name of the request a sink actor sends to this processor. */
export const OTLP_EXPORT_EVENT = 'otlp.export';

export const POST_TIMEOUT_MS = 15_000;
/** Largest single POST; bigger groups are split. */
export const MAX_POST_BYTES = 4 * 1024 ** 2;

export interface QueuedBatch {
	signal: TelemetrySignal;
	contentType: 'application/x-protobuf' | 'application/json';
	bytes: Uint8Array;
	service: string;
}

export interface OtlpExportRequest {
	sinkId: string;
	batches: QueuedBatch[];
}

export class AuthUnavailable extends Error {}

/** Headers for a sink's auth mode; reveals secrets through `secrets` (or unsaved candidates). */
export async function authHeaders(
	auth: SinkAuth,
	secrets: SecretReader,
	purpose: string,
	candidates: Record<string, string> = {}
): Promise<Record<string, string>> {
	const reveal = async (ref: string) => {
		if (candidates[ref] !== undefined) return candidates[ref]!;
		try {
			return await secrets.reveal(ref, purpose);
		} catch (e) {
			throw new AuthUnavailable(`secret ${ref} unavailable: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	switch (auth.mode) {
		case 'none':
		case 'exe-peer':
			return {};
		case 'exe-vm-token':
			return { [EXE_AUTH_HEADER]: `Bearer ${await reveal(auth.token.secretRef)}` };
		case 'bearer':
			return { Authorization: `Bearer ${await reveal(auth.token.secretRef)}` };
		case 'basic':
			return { Authorization: `Basic ${Buffer.from(`${auth.username}:${await reveal(auth.password.secretRef)}`).toString('base64')}` };
		case 'header':
			return { [auth.header]: await reveal(auth.value.secretRef) };
	}
}

export function secretRefOf(auth: SinkAuth): string | null {
	switch (auth.mode) {
		case 'exe-vm-token':
		case 'bearer':
			return auth.token.secretRef;
		case 'basic':
			return auth.password.secretRef;
		case 'header':
			return auth.value.secretRef;
		default:
			return null;
	}
}

const JSON_ROOT: Record<TelemetrySignal, string> = { traces: 'resourceSpans', logs: 'resourceLogs', metrics: 'resourceMetrics' };

/** Merge batches of one signal and content type into POST bodies (protobuf requests concatenate). */
export function groupBodies(batches: QueuedBatch[]): { signal: TelemetrySignal; contentType: QueuedBatch['contentType']; body: Uint8Array }[] {
	const groups = new Map<string, QueuedBatch[]>();
	for (const b of batches) {
		const k = `${b.signal} ${b.contentType}`;
		let g = groups.get(k);
		if (!g) groups.set(k, (g = []));
		g.push(b);
	}
	const out: { signal: TelemetrySignal; contentType: QueuedBatch['contentType']; body: Uint8Array }[] = [];
	for (const g of groups.values()) {
		const { signal, contentType } = g[0]!;
		if (contentType === 'application/x-protobuf') {
			// Concatenated serialized messages of the same type merge their repeated fields.
			let chunk: Uint8Array[] = [];
			let size = 0;
			const flush = () => {
				if (!chunk.length) return;
				const body = new Uint8Array(size);
				let o = 0;
				for (const c of chunk) {
					body.set(c, o);
					o += c.length;
				}
				out.push({ signal, contentType, body });
				chunk = [];
				size = 0;
			};
			for (const b of g) {
				if (size && size + b.bytes.length > MAX_POST_BYTES) flush();
				chunk.push(b.bytes);
				size += b.bytes.length;
			}
			flush();
		} else {
			const root = JSON_ROOT[signal];
			const merged: unknown[] = [];
			for (const b of g) {
				try {
					const doc = JSON.parse(new TextDecoder().decode(b.bytes)) as Record<string, unknown[]>;
					merged.push(...(doc[root] ?? []));
				} catch {
					/* malformed ops-generated JSON: skip */
				}
			}
			if (merged.length) out.push({ signal, contentType, body: new TextEncoder().encode(JSON.stringify({ [root]: merged })) });
		}
	}
	return out;
}

export function retryAfterMs(res: Response, now: number): number | null {
	const h = res.headers.get('retry-after');
	if (!h) return null;
	const secs = Number(h);
	if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
	const at = Date.parse(h);
	return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface OtlpDeps {
	repo: SinksRepo;
	secrets: () => SecretReader;
	redactor: Redactor;
	log: OpsLogger;
	now: () => number;
	/** Bytes actually delivered to a sink (volume accounting, ADR 0107). */
	onDelivered(sinkId: string, bytes: number): void;
}

async function post(url: string, body: Uint8Array, contentType: string, headers: Record<string, string>, signal: AbortSignal) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': contentType, ...headers },
		body: body as unknown as BodyInit,
		signal: AbortSignal.any([signal, AbortSignal.timeout(POST_TIMEOUT_MS)])
	});
}

export function otlpProcessor(deps: OtlpDeps): IOProcessor {
	/** Sink failure logs are rate-limited to one per sink per minute (ADR 0093). */
	const lastLog = new Map<string, number>();
	const logFailure = (sinkId: string, msg: string) => {
		const now = deps.now();
		if (now - (lastLog.get(sinkId) ?? 0) < 60_000) return;
		lastLog.set(sinkId, now);
		deps.log.warn(`ops telemetry: sink ${sinkId}: ${msg}`);
	};

	async function run(request: IORequest, ctx: EffectContext): Promise<void> {
		const data = request.data as OtlpExportRequest;
		const reply = (event: string, payload: unknown) => {
			try {
				ctx.post(request.source, event, payload);
			} catch {
				/* the sink actor is gone (deleted/disabled) */
			}
		};
		const fail = (status: number | null, message: string, retryAfter: number | null = null) => {
			const safe = deps.redactor.redact(message).slice(0, 500);
			logFailure(data.sinkId, safe);
			reply('sink.failed', { status, retryAfterMs: retryAfter, message: safe });
		};
		const sink = deps.repo.get(data.sinkId);
		if (!sink) return fail(null, 'sink no longer configured');
		const ref = secretRefOf(sink.auth);
		let headers: Record<string, string>;
		try {
			headers = await authHeaders(sink.auth, deps.secrets(), `telemetry sink ${sink.id}`);
		} catch (e) {
			return fail(null, e instanceof Error ? e.message : String(e));
		}
		const bodies = groupBodies(data.batches);
		// A half-open probe with nothing queued: an empty export request proves the path.
		if (bodies.length === 0) bodies.push({ signal: sink.signals[0] ?? 'traces', contentType: 'application/x-protobuf', body: new Uint8Array(0) });
		let bytes = 0;
		for (const b of bodies) {
			const url = `${sink.endpoint}/v1/${b.signal}`;
			let res: Response;
			try {
				res = await post(url, b.body, b.contentType, headers, ctx.signal);
			} catch (e) {
				if (ref) deps.secrets().recordUse(ref, false);
				return fail(null, `POST ${url}: ${e instanceof Error ? e.message : String(e)}`);
			}
			await res.arrayBuffer().catch(() => undefined);
			if (!res.ok) {
				if (ref && (res.status === 401 || res.status === 403)) deps.secrets().recordUse(ref, false);
				return fail(res.status, `POST ${url}: HTTP ${res.status}`, retryAfterMs(res, deps.now()));
			}
			bytes += b.body.length;
			deps.onDelivered(sink.id, b.body.length);
		}
		if (ref) deps.secrets().recordUse(ref, true);
		reply('sink.sent', { batches: data.batches.length, bytes });
	}

	return {
		send(request, ctx) {
			// Never reject: failures are replies, not error.communication.
			return run(request, ctx).catch((e) => deps.log.error('ops telemetry: otlp processor crashed', e));
		}
	};
}

/**
 * Test connection for a sink (ADR 0099): POST an empty export request per
 * signal and expect 2xx. `exe-peer` can only prove reachability from this VM.
 */
export async function testSinkConnection(input: {
	endpoint: string;
	auth: SinkAuth;
	signals: TelemetrySignal[];
	secrets: SecretReader;
	candidates?: Record<string, string>;
	redactor: Redactor;
	now: () => number;
}): Promise<TestConnectionResult> {
	const at = input.now();
	const endpoint = input.endpoint.replace(/\/+$/, '');
	const steps: TestStep[] = [];
	const advisories: TestConnectionResult['advisories'] = [];
	let headers: Record<string, string> | null = null;
	const t0 = performance.now();
	try {
		headers = await authHeaders(input.auth, input.secrets, 'telemetry sink test', input.candidates ?? {});
		steps.push({ name: 'credentials', ok: true, skipped: input.auth.mode === 'none' || input.auth.mode === 'exe-peer', durationMs: Math.round(performance.now() - t0), detail: null, providerCode: null });
	} catch (e) {
		steps.push({ name: 'credentials', ok: false, skipped: false, durationMs: Math.round(performance.now() - t0), detail: input.redactor.redact(e instanceof Error ? e.message : String(e)), providerCode: null });
	}
	for (const signal of input.signals) {
		if (!headers) {
			steps.push({ name: `POST /v1/${signal}`, ok: false, skipped: true, durationMs: 0, detail: 'credentials unavailable', providerCode: null });
			continue;
		}
		const t = performance.now();
		try {
			const res = await fetch(`${endpoint}/v1/${signal}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-protobuf', ...headers },
				body: new Uint8Array(0),
				signal: AbortSignal.timeout(10_000)
			});
			await res.arrayBuffer().catch(() => undefined);
			const detail = res.ok
				? null
				: res.status === 401 || res.status === 403
					? `HTTP ${res.status}: credentials rejected`
					: res.status === 404
						? `HTTP 404: no OTLP receiver at ${endpoint}/v1/${signal}`
						: `HTTP ${res.status}`;
			steps.push({ name: `POST /v1/${signal}`, ok: res.ok, skipped: false, durationMs: Math.round(performance.now() - t), detail, providerCode: res.ok ? null : String(res.status) });
		} catch (e) {
			steps.push({ name: `POST /v1/${signal}`, ok: false, skipped: false, durationMs: Math.round(performance.now() - t), detail: input.redactor.redact(e instanceof Error ? e.message : String(e)), providerCode: null });
		}
	}
	if (input.auth.mode === 'exe-peer')
		advisories.push({
			title: 'exe.dev peer integration',
			detail:
				'granary stores no credential in this mode; exe.dev injects it. The test only proves this VM reaches the integration. Set it up with: ssh exe.dev integrations add http-proxy --name grafana-otlp --target https://<grafana-vm>.exe.xyz:4318/ --peer --attach vm:<granary-vm>',
			docsUrl: 'https://exe.dev/docs/integrations-vm-to-vm.md'
		});
	if (input.auth.mode === 'exe-vm-token')
		advisories.push({
			title: 'exe.dev VM token',
			detail: 'Create one with: ssh exe.dev ssh-key generate-api-key --vm=<grafana-vm> --label=granary-otlp',
			docsUrl: 'https://exe.dev/docs/https-tokens-for-vms.md'
		});
	return { ok: steps.every((s) => s.ok || s.skipped) && steps.some((s) => s.ok && !s.skipped), at, resolvedEndpoint: endpoint, steps, advisories };
}
