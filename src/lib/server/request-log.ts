/**
 * HTTP access log and request spans (ADR 0234).
 *
 * Every request runs inside a log context carrying a fresh trace id / span id,
 * so everything logged while handling it (webhook outcome, admin actions)
 * correlates with its trace in Grafana. When the request finishes:
 * - one access-log record: `GET /ops 200 12ms` with method, route, path,
 *   status, duration, client address, user and user agent as attributes;
 *   5xx → error, health probes and static assets → debug, others → info;
 * - one `server` span (except probes/assets), the root of any actor trace the
 *   request started (webhooks post `issue.opened` with its traceparent).
 *
 * Never recorded: cookies, request bodies, the login-link token in
 * `/auth/link/<token>`, and values of sensitive query parameters (OAuth
 * `code`/`state`, tokens, secrets).
 */
import { randomBytes } from 'node:crypto';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import type { DecodedSpan } from '@tinyactors/node';
import { log, withLogContext, SENSITIVE_LOG_KEY, type LogAttrs } from './log';
import { getRuntime } from './system';
import { SERVICE_NAME } from './tracing';
import { VERSION } from '$lib/version';

const PROBES = new Set(['/healthz', '/readyz']);
const ASSET = /^\/(_app\/immutable\/|favicon|robots\.txt)/;
const SENSITIVE_QUERY = new Set(['code', 'state', 'token', 'access_token', 'refresh_token', 'client_secret', 'key', 'signature', 'sig', 'password']);

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

/** The path as logged: the login-link token is replaced. */
export function safePath(url: URL): string {
	return url.pathname.replace(/^\/auth\/link\/[^/]+/, '/auth/link/[redacted]');
}

/** The query string as logged: values of sensitive parameters replaced; '' when empty. */
export function safeQuery(url: URL): string {
	if (!url.search) return '';
	const parts: string[] = [];
	for (const [k, v] of url.searchParams) parts.push(`${k}=${SENSITIVE_QUERY.has(k.toLowerCase()) || SENSITIVE_LOG_KEY.test(k) ? '[redacted]' : v}`);
	return parts.join('&');
}

function clientAddress(event: RequestEvent): string | undefined {
	const fwd = event.request.headers.get('x-forwarded-for');
	if (fwd) return fwd.split(',')[0]!.trim();
	try {
		return event.getClientAddress();
	} catch {
		return undefined;
	}
}

function statusOf(e: unknown): number {
	if (isRedirect(e)) return e.status;
	if (isHttpError(e)) return e.status;
	return 500;
}

/** Handle one request inside its log context, then write the access log and span. */
export async function observeRequest(event: RequestEvent, handle: () => Response | Promise<Response>): Promise<Response> {
	const path = event.url.pathname;
	const quiet = PROBES.has(path) || ASSET.test(path);
	const traceId = newTraceId();
	const spanId = newSpanId();
	const startMs = Date.now();
	const t0 = performance.now();
	let status = 500;
	let failure: unknown = null;
	try {
		const res = await withLogContext({ traceId, spanId }, async () => handle());
		status = res.status;
		return res;
	} catch (e) {
		status = statusOf(e);
		if (status >= 500) failure = e;
		throw e;
	} finally {
		const durationMs = Math.round((performance.now() - t0) * 10) / 10;
		const method = event.request.method;
		// Remote functions (/_app/remote/<hash>/<name>) have no route id: name them after the function.
		const remote = /^\/_app\/remote\/[^/]+\/([^/?]+)/.exec(path)?.[1] ?? null;
		const route = event.route?.id ?? (remote ? `remote:${remote}` : null);
		const query = safeQuery(event.url);
		const attrs: LogAttrs = {
			'http.request.method': method,
			'http.route': route ?? undefined,
			'rpc.method': remote ?? undefined,
			'url.path': safePath(event.url),
			'url.query': query || undefined,
			'http.response.status_code': status,
			duration_ms: durationMs,
			'client.address': clientAddress(event),
			'user.login': event.locals.user?.login,
			'user_agent.original': event.request.headers.get('user-agent')?.slice(0, 256)
		};
		const line = `${method} ${safePath(event.url)} ${status} ${durationMs}ms`;
		withLogContext({ traceId, spanId }, () => {
			if (quiet) log.debug(line, attrs);
			else if (status >= 500) log.error(line, attrs, failure instanceof Error ? failure : {});
			else log.info(line, attrs);
		});
		if (!quiet) emitRequestSpan({ traceId, spanId, name: `${method} ${route ?? '(unmatched)'}`, startMs, durationMs, status, attrs });
	}
}

// Shared objects: the encoder groups spans by resource/scope identity.
const RESOURCE: DecodedSpan['resource'] = { attributes: { 'service.name': SERVICE_NAME, 'service.version': VERSION } };
const SCOPE: DecodedSpan['scope'] = { name: 'granary.http', version: VERSION };

function emitRequestSpan(r: { traceId: string; spanId: string; name: string; startMs: number; durationMs: number; status: number; attrs: LogAttrs }): void {
	const tracer = getRuntime()?.tracer;
	if (!tracer) return;
	const endMs = r.startMs + r.durationMs;
	const attributes: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(r.attrs)) if (v !== undefined && v !== null) attributes[k] = v;
	const span: DecodedSpan = {
		traceID: r.traceId,
		spanID: r.spanId,
		name: r.name,
		kind: 'server',
		startTime: r.startMs,
		endTime: endMs,
		startTimeUnixNano: BigInt(Math.round(r.startMs * 1e6)),
		endTimeUnixNano: BigInt(Math.round(endMs * 1e6)),
		attributes,
		events: [],
		links: [],
		status: r.status >= 500 ? { code: 'error' } : { code: 'unset' },
		resource: RESOURCE,
		scope: SCOPE
	};
	try {
		tracer.emitSpan(span);
	} catch (e) {
		log.debug('tracing: could not emit a request span', e);
	}
}
