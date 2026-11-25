/**
 * A sandbox serves its fake GitHub's pages under `/__sandbox/github` (ADR
 * 0315), so the GitHub links it shows (`FAKE_GITHUB_WEB_URL`,
 * `GRANARY_GITHUB_PAGES_URL`) open on the sandbox's own origin, through an
 * SSH tunnel or through production. Anywhere else: 404.
 */
import { error, type RequestHandler } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';

const PASS_REQUEST = ['content-type', 'accept', 'authorization'];
const PASS_RESPONSE = ['content-type', 'location', 'cache-control'];

export const fallback: RequestHandler = async ({ request, params, url }) => {
	const config = getConfig();
	if (!config.sandbox) error(404, 'Not Found');
	const target = new URL(`/${params.path ?? ''}${url.search}`, config.fakeGithubUrl + '/');
	const headers = new Headers();
	for (const k of PASS_REQUEST) {
		const v = request.headers.get(k);
		if (v !== null) headers.set(k, v);
	}
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	const res = await fetch(target, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, redirect: 'manual' });
	const out = new Headers();
	for (const k of PASS_RESPONSE) {
		const v = res.headers.get(k);
		if (v !== null) out.set(k, v);
	}
	return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
};
