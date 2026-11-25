/**
 * Production serves its sandbox to its admins (ADR 0315): while the
 * `granary_sandbox` cookie is set, every request of a production admin is
 * forwarded to the sandbox on this machine (`GRANARY_SANDBOX_URL`), except
 * the few paths production keeps. `/__sandbox/github/*` (the fake GitHub's
 * pages, served by the sandbox) is forwarded for admins with or without the
 * cookie, so links to it work from anywhere.
 *
 * Production only ever forwards to a process whose `/healthz` says
 * `sandbox: true`, on a loopback URL (checked by `loadConfig`).
 */
import type { Cookies } from '@sveltejs/kit';
import { HealthzResponse } from '$lib/schemas/health';
import { Value } from '@sinclair/typebox/value';
import { PRODUCTION_COOKIES } from './auth';

/** Set by "Enter the sandbox" (Admin → Sandbox). */
export const SANDBOX_COOKIE = 'granary_sandbox';
/** Production clears the cookie here and goes back to Admin → Sandbox. */
export const SANDBOX_LEAVE_PATH = '/__sandbox/leave';
/** The fake GitHub's pages, served by the sandbox. */
export const SANDBOX_GITHUB_PREFIX = '/__sandbox/github';
/** Added to every forwarded request; the sandbox then offers "Back to production". */
export const SANDBOX_VIA_HEADER = 'x-granary-sandbox-via';

/** Paths production always answers itself, even inside the sandbox. */
const KEEP = new Set(['/healthz', '/readyz', '/webhook', SANDBOX_LEAVE_PATH]);

export type SandboxStatus =
	| { state: 'off' }
	| { state: 'down'; url: string; error: string }
	| { state: 'not-a-sandbox'; url: string }
	| { state: 'up'; url: string; version: string; /** The origin the sandbox believes it has (its ORIGIN). */ origin: string };

const PROBE_TTL_MS = 3000;
let probeCache: { url: string; at: number; status: SandboxStatus } | null = null;

/** Is a sandbox answering at `url`? Cached for a few seconds. */
export async function probeSandbox(url: string | null): Promise<SandboxStatus> {
	if (!url) return { state: 'off' };
	const now = Date.now();
	if (probeCache && probeCache.url === url && now - probeCache.at < PROBE_TTL_MS) return probeCache.status;
	let status: SandboxStatus;
	try {
		const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
		const body: unknown = res.ok ? await res.json() : null;
		if (!Value.Check(HealthzResponse, body)) status = { state: 'not-a-sandbox', url };
		else status = body.sandbox ? { state: 'up', url, version: body.version, origin: body.origin ?? new URL(url).origin } : { state: 'not-a-sandbox', url };
	} catch (e) {
		status = { state: 'down', url, error: e instanceof Error ? e.message : String(e) };
	}
	probeCache = { url, at: now, status };
	return status;
}

export function setSandboxCookie(cookies: Cookies, url: URL): void {
	cookies.set(SANDBOX_COOKIE, '1', { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });
}

export function clearSandboxCookie(cookies: Cookies, url: URL): void {
	cookies.delete(SANDBOX_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });
}

/** Should this request go to the sandbox? (The caller has checked that the visitor is a production admin.) */
export function forwardsToSandbox(pathname: string, cookieSet: boolean): boolean {
	if (pathname === SANDBOX_GITHUB_PREFIX || pathname.startsWith(SANDBOX_GITHUB_PREFIX + '/')) return true;
	return cookieSet && !KEEP.has(pathname);
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length'];
const STRIPPED_COOKIES = new Set<string>([PRODUCTION_COOKIES.session, PRODUCTION_COOKIES.oauthState, SANDBOX_COOKIE]);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Forward one request to a sandbox that answered its probe, and return its
 * answer. `url` is the request's URL on production.
 */
export async function forwardToSandbox(request: Request, url: URL, to: Extract<SandboxStatus, { state: 'up' }>): Promise<Response> {
	const sandbox = new URL(to.url);
	const own = to.origin;
	// Production's own CSRF check: a state-changing request must come from production's pages.
	const from = request.headers.get('origin');
	if (UNSAFE.has(request.method) && from !== null && from !== url.origin) {
		return new Response('Cross-site request to the sandbox refused', { status: 403 });
	}
	const headers = new Headers();
	for (const [k, v] of request.headers) {
		if (HOP_BY_HOP.includes(k)) continue;
		if (k === 'cookie') {
			const kept = v
				.split(';')
				.map((c) => c.trim())
				.filter((c) => c && !STRIPPED_COOKIES.has(c.slice(0, c.indexOf('=') < 0 ? c.length : c.indexOf('='))));
			if (kept.length) headers.set('cookie', kept.join('; '));
			continue;
		}
		headers.set(k, v);
	}
	// The sandbox checks Origin against its own origin (SvelteKit's CSRF check).
	if (from !== null) headers.set('origin', own);
	const referer = request.headers.get('referer');
	if (referer?.startsWith(url.origin + '/')) headers.set('referer', own + referer.slice(url.origin.length));
	headers.set('accept-encoding', 'identity');
	headers.set('x-forwarded-host', url.host);
	headers.set('x-forwarded-proto', url.protocol.replace(/:$/, ''));
	headers.set(SANDBOX_VIA_HEADER, 'production');

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	let res: Response;
	try {
		res = await fetch(new URL(url.pathname + url.search, sandbox), {
			method: request.method,
			headers,
			body: hasBody ? await request.arrayBuffer() : undefined,
			redirect: 'manual'
		});
	} catch (e) {
		return new Response(`The sandbox at ${sandbox.origin} does not answer (${e instanceof Error ? e.message : String(e)}). Leave it at ${SANDBOX_LEAVE_PATH}.`, {
			status: 502,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
	const out = new Headers();
	for (const [k, v] of res.headers) {
		if (HOP_BY_HOP.includes(k) || k === 'content-encoding' || k === 'set-cookie') continue;
		out.set(k, v);
	}
	for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
	// Redirects to the sandbox's own origin stay on production's.
	const location = res.headers.get('location');
	if (location) {
		const abs = new URL(location, own);
		if (abs.origin === own || abs.origin === sandbox.origin) out.set('location', abs.pathname + abs.search + abs.hash);
	}
	return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
}
