/**
 * fake-infra control API and state (ADR 0090, 0103). fake-infra stands in
 * for Cloudflare R2 (S3 API with R2 fidelity), an OTLP receiver, and the
 * exe.dev HTTPS proxy in front of it. Independent of src/lib/ops (it only
 * shares the Standard Schema adapter). Relative imports only (plain Bun).
 */
import { Type, type Static } from '@sinclair/typebox';

export const FAKE_INFRA_DEFAULT_PORT = 4090;

export const CONTROL_PATHS = {
	reset: '/__control/reset',
	buckets: '/__control/buckets', // POST create, DELETE /:name
	credentials: '/__control/credentials', // POST issue, DELETE /:id revoke
	faults: '/__control/faults', // POST inject, DELETE clear all
	fidelity: '/__control/fidelity', // PUT toggles
	clock: '/__control/clock', // PUT skew
	exeProxy: '/__control/exe-proxy', // PUT proxy config
	objects: '/__control/objects', // POST seed synthetic objects (retention tests)
	state: '/__control/state', // GET
	events: '/__control/events' // GET SSE
} as const;

/** Served surfaces (not control): S3 path-style under /s3, OTLP under /otlp, exe proxy front on its own port. */
export const SURFACE_PATHS = { s3: '/s3', otlp: '/otlp' } as const;

export const ControlOk = Type.Object({ ok: Type.Literal(true) });
export const ControlError = Type.Object({ error: Type.String(), details: Type.Optional(Type.Array(Type.String())) });

export const Jurisdiction = Type.Union([Type.Literal('default'), Type.Literal('eu'), Type.Literal('fedramp')]);

export const CreateBucketRequest = Type.Object(
	{
		name: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }),
		jurisdiction: Type.Optional(Jurisdiction),
		/** Simulated quota; writes beyond it fail like a full disk/quota. */
		quotaBytes: Type.Optional(Type.Integer({ minimum: 0 }))
	},
	{ additionalProperties: false }
);
export type CreateBucketRequest = Static<typeof CreateBucketRequest>;

export const CredentialScope = Type.Union([Type.Literal('object-rw'), Type.Literal('object-ro'), Type.Literal('admin')]);
export const IssueCredentialRequest = Type.Union([
	Type.Object({ kind: Type.Literal('s3'), scope: CredentialScope, buckets: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal('exe-vm-token'), label: Type.String() }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal('otlp-bearer'), label: Type.String() }, { additionalProperties: false })
]);
export type IssueCredentialRequest = Static<typeof IssueCredentialRequest>;

export const IssuedCredential = Type.Union([
	Type.Object({ id: Type.String(), kind: Type.Literal('s3'), accessKeyId: Type.String(), secretAccessKey: Type.String() }),
	Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal('exe-vm-token'), Type.Literal('otlp-bearer')]), token: Type.String() })
]);
export type IssuedCredential = Static<typeof IssuedCredential>;

export const FaultTarget = Type.Union([Type.Literal('s3'), Type.Literal('otlp'), Type.Literal('exe-proxy')]);
export const InjectFaultRequest = Type.Object(
	{
		target: FaultTarget,
		method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('PUT'), Type.Literal('POST'), Type.Literal('DELETE'), Type.Literal('HEAD'), Type.Literal('*')])),
		/** Unanchored RegExp source tested against the path (incl. query for S3 sub-resources). */
		pathPattern: Type.String({ minLength: 1 }),
		status: Type.Optional(Type.Integer({ minimum: 400, maximum: 599 })),
		/** S3 error code in the XML body, e.g. SlowDown, InternalError, AccessDenied. */
		s3Code: Type.Optional(Type.String()),
		count: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
		retryAfterSec: Type.Optional(Type.Integer({ minimum: 0 })),
		latencyMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
		dropConnection: Type.Optional(Type.Boolean()),
		corruptBody: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: false }
);
export type InjectFaultRequest = Static<typeof InjectFaultRequest>;
export const InjectFaultResponse = Type.Object({ id: Type.String() });

/** R2 fidelity toggles (ADR 0103). All default true except the rate limit. */
export const FidelityRequest = Type.Object(
	{
		sigV4: Type.Boolean(),
		regionAuto: Type.Boolean(),
		conditionalWrites: Type.Boolean(),
		/** Presigned PUT honours an unsigned If-None-Match header. */
		conditionalOnPresigned: Type.Boolean(),
		equalPartSizes: Type.Boolean(),
		/** 1 write/s per key → 429 SlowDown. */
		perKeyWriteRateLimit: Type.Boolean(),
		/** Versioning / object-lock endpoints answer NotImplemented like R2. */
		r2NotImplemented: Type.Boolean()
	},
	{ additionalProperties: false }
);
export type FidelityRequest = Static<typeof FidelityRequest>;

export const ClockRequest = Type.Object({ skewMs: Type.Integer() }, { additionalProperties: false });

/** exe.dev proxy fake in front of the OTLP receiver (ADR 0103). */
export const ExeProxyRequest = Type.Object(
	{
		/** Port for the token-authenticated front (stands in for https://<vm>.exe.xyz:4318). */
		tokenMode: Type.Boolean(),
		/** Port for the peer-integration front (stands in for http://<n>.int.exe.xyz); no auth, adds X-Exedev-Source-Vm. */
		peerMode: Type.Boolean(),
		peerSourceVm: Type.Optional(Type.String())
	},
	{ additionalProperties: false }
);

/** Seed synthetic backups for retention tests (ADR 0103 #13). */
export const SeedObjectsRequest = Type.Object(
	{
		bucket: Type.String(),
		objects: Type.Array(
			Type.Object({ key: Type.String({ minLength: 1 }), bytes: Type.Integer({ minimum: 0 }), lastModified: Type.Integer({ minimum: 0 }), body: Type.Optional(Type.String()) }),
			{ maxItems: 5000 }
		)
	},
	{ additionalProperties: false }
);
export type SeedObjectsRequest = Static<typeof SeedObjectsRequest>;

export const FakeObject = Type.Object({ key: Type.String(), size: Type.Integer(), etag: Type.String(), lastModified: Type.Integer() });
export const FakeBucket = Type.Object({
	name: Type.String(),
	jurisdiction: Jurisdiction,
	quotaBytes: Type.Union([Type.Integer(), Type.Null()]),
	usedBytes: Type.Integer(),
	objects: Type.Array(FakeObject),
	multipartUploads: Type.Array(Type.Object({ uploadId: Type.String(), key: Type.String(), parts: Type.Integer(), initiatedAt: Type.Integer() }))
});
export const FakeRequestLog = Type.Object({
	at: Type.Integer(),
	surface: Type.Union([Type.Literal('s3'), Type.Literal('otlp'), Type.Literal('exe-proxy')]),
	method: Type.String(),
	path: Type.String(),
	status: Type.Integer(),
	bytesIn: Type.Integer(),
	credentialId: Type.Union([Type.String(), Type.Null()]),
	faultId: Type.Union([Type.String(), Type.Null()])
});
export const FakeOtlpBatch = Type.Object({
	at: Type.Integer(),
	signal: Type.Union([Type.Literal('traces'), Type.Literal('logs'), Type.Literal('metrics')]),
	contentType: Type.String(),
	bytes: Type.Integer(),
	service: Type.Union([Type.String(), Type.Null()]),
	via: Type.Union([Type.Literal('direct'), Type.Literal('exe-token'), Type.Literal('exe-peer')]),
	/** Decoded span names / log bodies (truncated) for assertions. */
	summary: Type.Array(Type.String())
});

export const FakeInfraState = Type.Object({
	buckets: Type.Array(FakeBucket),
	credentials: Type.Array(Type.Object({ id: Type.String(), kind: Type.String(), scope: Type.Union([Type.String(), Type.Null()]), revoked: Type.Boolean(), label: Type.Union([Type.String(), Type.Null()]) })),
	faults: Type.Array(Type.Intersect([InjectFaultRequest, Type.Object({ id: Type.String(), remaining: Type.Integer() })])),
	fidelity: FidelityRequest,
	clockSkewMs: Type.Integer(),
	exeProxy: Type.Object({ tokenPort: Type.Union([Type.Integer(), Type.Null()]), peerPort: Type.Union([Type.Integer(), Type.Null()]) }),
	otlp: Type.Array(FakeOtlpBatch),
	requests: Type.Array(FakeRequestLog),
	counters: Type.Object({ s3Puts: Type.Integer(), s3Deletes: Type.Integer(), s3BytesIn: Type.Integer(), otlpBatches: Type.Integer() })
});
export type FakeInfraState = Static<typeof FakeInfraState>;

/** SSE events on /__control/events. */
export const FakeInfraEvent = Type.Union([
	Type.Object({ type: Type.Literal('s3.request'), request: FakeRequestLog }),
	Type.Object({ type: Type.Literal('otlp.batch'), batch: FakeOtlpBatch }),
	Type.Object({ type: Type.Literal('fault.fired'), faultId: Type.String(), remaining: Type.Integer() }),
	Type.Object({ type: Type.Literal('reset') })
]);
export type FakeInfraEvent = Static<typeof FakeInfraEvent>;
