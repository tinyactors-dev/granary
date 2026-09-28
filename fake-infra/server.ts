/**
 * fake-infra (ADR 0090, 0103, 0130–0139): a separate Bun process with its own
 * tinyactors System standing in for Cloudflare R2 (S3 API with R2 fidelity),
 * an OTLP/HTTP receiver (Grafana/otel-lgtm), and exe.dev's HTTPS proxy in
 * front of it — plus the `/__control` API and a small HTML page at `/`.
 *
 * Env:
 * - FAKE_INFRA_PORT (4090): main listener (S3 under /s3, OTLP under /otlp, control, page)
 * - FAKE_INFRA_EXE_TOKEN_PORT (port+1), FAKE_INFRA_EXE_PEER_PORT (port+2): exe proxy fronts (0 = ephemeral)
 * - FAKE_INFRA_SEED_BUCKET, FAKE_INFRA_SEED_JURISDICTION, FAKE_INFRA_SEED_ACCESS_KEY_ID,
 *   FAKE_INFRA_SEED_SECRET_ACCESS_KEY, FAKE_INFRA_SEED_EXE_TOKEN: dev seeds, re-applied after reset
 * - OTEL_EXPORTER_OTLP_ENDPOINT: export own traces (service.name=fake-infra)
 */
import type { TSchema, Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import {
	CONTROL_PATHS,
	ClockRequest,
	CreateBucketRequest,
	ExeProxyRequest,
	FAKE_INFRA_DEFAULT_PORT,
	FidelityRequest,
	InjectFaultRequest,
	IssueCredentialRequest,
	SeedObjectsRequest,
	type IssuedCredential
} from './schemas';
import { issuesOf } from '../src/lib/schemas/standard';
import { ask, isFailure } from './io/reply';
import { createInfraSystem } from './system';
import { InfraLog } from './events';
import { SETTINGS_ADDRESS, SETTINGS_EVENTS, type Settings } from './actors/settings';
import { CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS, type Credential } from './actors/credentials';
import { FAULTS_ADDRESS, FAULT_EVENTS } from './actors/faults';
import { BUCKET_EVENTS, bucketAddress, type Jurisdiction } from './actors/bucket';
import { handleS3, isS3Request } from './s3/handler';
import { OTLP_PREFIX, handleOtlp } from './otlp/handler';
import { ExeProxy } from './exe-proxy';
import * as blobs from './blobs';
import { controlPage } from './page';

const env = process.env;
const nonEmpty = (v: string | undefined) => (v && v.length ? v : undefined);
const port = Number(nonEmpty(env.FAKE_INFRA_PORT) ?? FAKE_INFRA_DEFAULT_PORT);
const portOr = (v: string | undefined, fallback: number) => (v === undefined || v === '' ? fallback : Number(v));
const exePorts = {
	token: portOr(env.FAKE_INFRA_EXE_TOKEN_PORT, port === 0 ? 0 : port + 1),
	peer: portOr(env.FAKE_INFRA_EXE_PEER_PORT, port === 0 ? 0 : port + 2)
};

const infra = createInfraSystem({ otlpEndpoint: nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? null });
const { system } = infra;
const log = new InfraLog();
const exeProxy = new ExeProxy({ system, log }, exePorts);
exeProxy.configure({ tokenMode: true, peerMode: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = () => json({ ok: true });
const controlError = (status: number, error: string, details?: string[]) => json(details ? { error, details } : { error }, status);

class HttpError extends Error {
	constructor(readonly response: Response) {
		super('http error');
	}
}

async function readJson(req: Request): Promise<unknown> {
	const text = await req.text();
	if (!text.trim()) throw new HttpError(controlError(400, 'Request body must be JSON'));
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new HttpError(controlError(400, `Malformed JSON: ${(e as Error).message}`));
	}
}

function validate<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	const issues = issuesOf(schema, value);
	if (issues.length) throw new HttpError(controlError(400, `Invalid ${what}`, issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)));
	return value as Static<T>;
}

const hex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
const newId = (prefix: string) => `${prefix}_${hex(6)}`;

// ---------------------------------------------------------------------------
// control operations
// ---------------------------------------------------------------------------

async function createBucket(r: CreateBucketRequest): Promise<Response> {
	if (infra.bucketExists(r.name)) return controlError(409, `Bucket ${r.name} already exists`);
	infra.createBucket(r.name, (r.jurisdiction ?? 'default') as Jurisdiction, r.quotaBytes ?? null);
	const bucket = infra.snapshot(log, exeProxy.state).buckets.find((b) => b.name === r.name);
	return json(bucket, 201);
}

async function issueCredential(r: IssueCredentialRequest, fixed?: { accessKeyId?: string; secretAccessKey?: string; token?: string }): Promise<IssuedCredential> {
	const id = newId('cred');
	const material = {
		// R2-shaped: 32 hex access key id, 64 hex secret.
		accessKeyId: fixed?.accessKeyId ?? hex(16),
		secretAccessKey: fixed?.secretAccessKey ?? hex(32),
		token: fixed?.token ?? `${r.kind === 'exe-vm-token' ? 'exe' : 'otlp'}_${hex(24)}`
	};
	const c = await ask<Credential>(system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.issue, { id, request: r, material });
	return c.kind === 's3' ? { id: c.id, kind: 's3', accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! } : { id: c.id, kind: c.kind, token: c.token! };
}

async function applyExeProxy(r: { tokenMode: boolean; peerMode: boolean; peerSourceVm?: string }) {
	await ask<Settings>(system, SETTINGS_ADDRESS, SETTINGS_EVENTS.exeProxy, r);
	exeProxy.configure(r);
	return exeProxy.state;
}

async function applySeeds(): Promise<void> {
	const bucket = nonEmpty(env.FAKE_INFRA_SEED_BUCKET);
	if (bucket && !infra.bucketExists(bucket)) {
		infra.createBucket(bucket, (nonEmpty(env.FAKE_INFRA_SEED_JURISDICTION) ?? 'eu') as Jurisdiction, null);
		const accessKeyId = nonEmpty(env.FAKE_INFRA_SEED_ACCESS_KEY_ID);
		const secretAccessKey = nonEmpty(env.FAKE_INFRA_SEED_SECRET_ACCESS_KEY);
		if (accessKeyId && secretAccessKey) await issueCredential({ kind: 's3', scope: 'object-rw', buckets: [bucket] }, { accessKeyId, secretAccessKey });
	}
	const exeToken = nonEmpty(env.FAKE_INFRA_SEED_EXE_TOKEN);
	if (exeToken) await issueCredential({ kind: 'exe-vm-token', label: 'seed' }, { token: exeToken });
}

async function seedObjects(r: SeedObjectsRequest): Promise<Response> {
	if (!infra.bucketExists(r.bucket)) return controlError(404, `No bucket ${r.bucket}`);
	const objects = r.objects.map((o) => {
		const bytes = o.body !== undefined ? new TextEncoder().encode(o.body) : null;
		const blobId = bytes ? blobs.putBytes(bytes) : blobs.putSynthetic(o.bytes);
		return { key: o.key, size: bytes?.byteLength ?? o.bytes, etag: bytes ? blobs.md5(bytes) : `synthetic${hex(8)}`, lastModified: o.lastModified, blobId };
	});
	const res = await ask<{ seeded: number; dropBlobIds: string[] }>(system, bucketAddress(r.bucket), BUCKET_EVENTS.seed, { objects });
	for (const id of res.dropBlobIds) blobs.drop(id);
	return json({ ok: true, seeded: res.seeded });
}

async function control(req: Request, url: URL): Promise<Response | null> {
	const { pathname: path } = url;
	const method = req.method;
	const P = CONTROL_PATHS;

	if (path === P.reset && method === 'POST') {
		infra.reset();
		log.reset();
		exeProxy.configure({ tokenMode: true, peerMode: true, peerSourceVm: 'granary' });
		await applySeeds();
		return ok();
	}
	if (path === P.buckets && method === 'POST') return createBucket(validate(CreateBucketRequest, await readJson(req), 'bucket'));
	if (path.startsWith(`${P.buckets}/`) && method === 'DELETE') {
		const name = decodeURIComponent(path.slice(P.buckets.length + 1));
		return infra.deleteBucket(name) ? ok() : controlError(404, `No bucket ${name}`);
	}
	if (path === P.credentials && method === 'POST') return json(await issueCredential(validate(IssueCredentialRequest, await readJson(req), 'credential')), 201);
	if (path.startsWith(`${P.credentials}/`) && method === 'DELETE') {
		const id = decodeURIComponent(path.slice(P.credentials.length + 1));
		const res = await ask(system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.revoke, { id });
		return isFailure(res) ? controlError(404, res.error) : ok();
	}
	if (path === P.faults && method === 'POST') {
		const r = validate(InjectFaultRequest, await readJson(req), 'fault');
		try {
			new RegExp(r.pathPattern);
		} catch (e) {
			return controlError(400, `Invalid pathPattern: ${(e as Error).message}`);
		}
		return json(await ask(system, FAULTS_ADDRESS, FAULT_EVENTS.inject, { ...r, id: newId('fault') }), 201);
	}
	if (path === P.faults && method === 'DELETE') {
		await ask(system, FAULTS_ADDRESS, FAULT_EVENTS.clear);
		return ok();
	}
	if (path === P.fidelity && method === 'PUT') {
		// Full FidelityRequest, or any subset of its toggles (additive leniency, ADR 0132).
		const r = validate(Type.Partial(FidelityRequest), await readJson(req), 'fidelity');
		await ask(system, SETTINGS_ADDRESS, SETTINGS_EVENTS.fidelity, r);
		return ok();
	}
	if (path === P.clock && method === 'PUT') {
		const r = validate(ClockRequest, await readJson(req), 'clock');
		await ask(system, SETTINGS_ADDRESS, SETTINGS_EVENTS.clock, r);
		return ok();
	}
	if (path === P.exeProxy && method === 'PUT') return json(await applyExeProxy(validate(ExeProxyRequest, await readJson(req), 'exe proxy config')));
	if (path === P.objects && method === 'POST') return seedObjects(validate(SeedObjectsRequest, await readJson(req), 'objects'));
	if (path === P.state && method === 'GET') return json(infra.snapshot(log, exeProxy.state));
	if (path === P.events && method === 'GET') return log.stream(req.signal);
	if (path.startsWith('/__control')) return controlError(404, `No control route ${method} ${path}`);
	return null;
}

async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (isS3Request(req, url)) return handleS3(req, url, { infra, system, log });
	if (url.pathname === OTLP_PREFIX || url.pathname.startsWith(`${OTLP_PREFIX}/`))
		return handleOtlp(req, url.pathname.slice(OTLP_PREFIX.length), 'direct', { system, log });
	const c = await control(req, url);
	if (c) return c;
	if (url.pathname === '/' && req.method === 'GET')
		return new Response(controlPage(`http://localhost:${server.port}`, exeProxy.state), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	if (url.pathname === '/healthz') return ok();
	return controlError(404, `Not found: ${req.method} ${url.pathname}`);
}

const server = Bun.serve({
	port,
	idleTimeout: 120,
	maxRequestBodySize: 2 * 1024 * 1024 * 1024,
	async fetch(req) {
		try {
			return await route(req);
		} catch (e) {
			if (e instanceof HttpError) return e.response;
			console.error('[fake-infra]', req.method, req.url, e);
			return json({ error: (e as Error).message }, 500);
		}
	}
});

await applySeeds();

console.log(
	`[fake-infra] listening on http://localhost:${server.port} (S3 ${'/s3'}, OTLP ${OTLP_PREFIX}); exe proxy token :${exeProxy.state.tokenPort}, peer :${exeProxy.state.peerPort}`
);

const shutdown = () => {
	exeProxy.stop();
	server.stop(true);
	system.close();
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
