/**
 * The S3-compatible surface with R2 fidelity (ADR 0131, 0132).
 *
 * Routing: path-style under `/s3/…`. The jurisdiction a request arrives
 * through comes from the Host header (`<account>.eu.r2.cloudflarestorage.com`
 * → `eu`) or a leading path segment (`/s3/eu/<bucket>/…`, `/s3/fedramp/…`);
 * otherwise `default`. Like R2, a bucket is only visible through its own
 * jurisdiction's endpoint (else `NoSuchBucket`). Bucket names are ≥ 3 chars,
 * so `eu` can never be a bucket.
 */
import type { System } from '@tinyactors/node';
import { ask, isFailure } from '../io/reply';
import * as blobs from '../blobs';
import { SETTINGS_ADDRESS, SETTINGS_EVENTS, type Settings } from '../actors/settings';
import { CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS, type Credential } from '../actors/credentials';
import { FAULTS_ADDRESS, FAULT_EVENTS, type Fault } from '../actors/faults';
import { BUCKET_EVENTS, bucketAddress, type Jurisdiction, type ListResult, type S3Failure, type StoredObject } from '../actors/bucket';
import { amzDateToMs, parseAuth, payloadMatches, signatureMatches } from './sigv4';
import { completeXml, decodeContinuation, errorXml, esc, initiateXml, listUploadsXml, listV2Xml, parseCompleteBody, xmlResponse } from './xml';
import type { InfraSystem } from '../system';
import type { InfraLog } from '../events';

export const S3_PREFIX = '/s3';
const R2_HOST = /^([0-9a-z-]+)\.(?:(eu|fedramp)\.)?r2\.cloudflarestorage\.com(?::\d+)?$/i;
/** Max clock difference SigV4 tolerates (S3 and R2: 15 minutes). */
export const MAX_SKEW_MS = 15 * 60 * 1000;
/** Sub-resources R2 does not implement (versioning, object lock). */
const R2_NOT_IMPLEMENTED = ['versioning', 'object-lock', 'retention', 'legal-hold', 'versions', 'versionId'];

export interface S3Context {
	infra: InfraSystem;
	system: System;
	log: InfraLog;
}

/** Does this request belong to the S3 surface? */
export const isS3Request = (req: Request, url: URL) =>
	url.pathname === S3_PREFIX || url.pathname.startsWith(`${S3_PREFIX}/`) || R2_HOST.test(req.headers.get('host') ?? '');

interface Route {
	jurisdiction: Jurisdiction;
	bucket: string | null;
	key: string;
}

function route(req: Request, url: URL): Route {
	let path = url.pathname;
	let jurisdiction: Jurisdiction = 'default';
	const host = R2_HOST.exec(req.headers.get('host') ?? '');
	if (host) jurisdiction = (host[2]?.toLowerCase() as Jurisdiction | undefined) ?? 'default';
	if (path === S3_PREFIX || path.startsWith(`${S3_PREFIX}/`)) path = path.slice(S3_PREFIX.length);
	const segs = path.split('/').slice(1);
	if (segs[0] === 'eu' || segs[0] === 'fedramp') jurisdiction = segs.shift() as Jurisdiction;
	const bucket = segs.shift() || null;
	const key = segs.map((s) => decodeURIComponent(s)).join('/');
	return { jurisdiction, bucket, key };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A response whose body errors immediately: the client sees a dropped connection. */
export const droppedConnection = () =>
	new Response(
		// Erroring in `pull` (not `start`) makes Bun close the socket mid-response,
		// which clients (fetch, Bun's S3 client) surface as a dropped connection.
		new ReadableStream({
			pull(c) {
				c.error(new Error('fake-infra: connection dropped by fault injection'));
			}
		}),
		{ status: 200 }
	);

const httpDate = (ms: number) => new Date(ms).toUTCString();

const fromFailure = (f: S3Failure, resource: string) => errorXml(f.status, f.code, f.error, resource);

type Access = 'read' | 'write';

function allowed(cred: Credential, bucket: string, access: Access): boolean {
	if (cred.scope === 'admin') return true;
	if (!cred.buckets.includes(bucket)) return false;
	return access === 'read' || cred.scope === 'object-rw';
}

export async function handleS3(req: Request, url: URL, ctx: S3Context): Promise<Response> {
	const started = Date.now();
	const r = route(req, url);
	const method = req.method.toUpperCase();
	const body = method === 'PUT' || method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
	let credentialId: string | null = null;
	let faultId: string | null = null;
	let kind: { put?: boolean; delete?: boolean } = {};

	const finish = (res: Response): Response => {
		ctx.log.request(
			{
				at: started,
				surface: 's3',
				method,
				path: url.pathname + url.search,
				status: res.status,
				bytesIn: body.byteLength,
				credentialId,
				faultId
			},
			kind
		);
		return res;
	};

	const settings = await ask<Settings>(ctx.system, SETTINGS_ADDRESS, SETTINGS_EVENTS.get);
	const f = settings.fidelity;
	const now = Date.now() + settings.clockSkewMs;
	const resource = `/${r.bucket ?? ''}${r.key ? `/${r.key}` : ''}`;

	// --- fault injection ------------------------------------------------------
	const fault = await ask<Fault | null>(ctx.system, FAULTS_ADDRESS, FAULT_EVENTS.check, {
		target: 's3',
		method,
		path: url.pathname + url.search
	});
	let corrupt = false;
	if (fault) {
		faultId = fault.id;
		ctx.log.emit({ type: 'fault.fired', faultId: fault.id, remaining: fault.remaining });
		if (fault.latencyMs) await sleep(fault.latencyMs);
		if (fault.dropConnection) return finish(droppedConnection());
		if (fault.status) {
			const headers: Record<string, string> = fault.retryAfterSec !== undefined ? { 'Retry-After': String(fault.retryAfterSec) } : {};
			const code = fault.s3Code ?? (fault.status === 503 ? 'SlowDown' : fault.status === 403 ? 'AccessDenied' : fault.status === 429 ? 'SlowDown' : 'InternalError');
			return finish(errorXml(fault.status, code, 'Injected fault', resource, headers));
		}
		corrupt = !!fault.corruptBody;
	}

	// --- authentication (SigV4) --------------------------------------------------
	let cred: Credential;
	if (f.sigV4) {
		const parsed = parseAuth(req, url);
		if (parsed.ok === 'anonymous') return finish(errorXml(403, 'AccessDenied', 'Anonymous access is not allowed', resource));
		if (parsed.ok === false) return finish(errorXml(400, parsed.code, parsed.message, resource));
		const auth = parsed.auth;
		const found = await ask<Credential | null>(ctx.system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.byKey, { accessKeyId: auth.accessKeyId });
		if (!found || found.revoked || !found.secretAccessKey)
			return finish(errorXml(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', resource));
		credentialId = found.id;
		if (auth.service !== 's3') return finish(errorXml(400, 'AuthorizationHeaderMalformed', `Service must be s3, got ${auth.service}`, resource));
		if (f.regionAuto && !['auto', 'us-east-1', ''].includes(auth.region))
			return finish(errorXml(400, 'AuthorizationHeaderMalformed', `The authorization header is malformed; the region '${auth.region}' is wrong; expecting 'auto'`, resource));
		const signedAt = amzDateToMs(auth.amzDate);
		if (!Number.isFinite(signedAt)) return finish(errorXml(403, 'AccessDenied', 'Invalid X-Amz-Date', resource));
		if (auth.presigned) {
			if (now > signedAt + (auth.expires ?? 0) * 1000) return finish(errorXml(403, 'AccessDenied', 'Request has expired', resource));
			if (signedAt - now > MAX_SKEW_MS) return finish(errorXml(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.', resource));
		} else if (Math.abs(now - signedAt) > MAX_SKEW_MS) {
			return finish(errorXml(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.', resource));
		}
		if (!signatureMatches(req, url, auth, found.secretAccessKey))
			return finish(
				errorXml(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.', resource)
			);
		if (!payloadMatches(auth, body)) return finish(errorXml(400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.', resource));
		cred = found;
	} else {
		cred = { id: 'anonymous', kind: 's3', scope: 'admin', buckets: [], accessKeyId: null, secretAccessKey: null, token: null, label: null, revoked: false };
	}
	const presigned = url.searchParams.has('X-Amz-Signature');

	// --- service level ---------------------------------------------------------
	if (!r.bucket) {
		if (method !== 'GET') return finish(errorXml(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', '/'));
		if (cred.scope !== 'admin') return finish(errorXml(403, 'AccessDenied', 'Access Denied', '/'));
		const names = ctx.infra.snapshotBucketNames(r.jurisdiction);
		return finish(
			xmlResponse(
				`<ListAllMyBucketsResult><Buckets>${names.map((n) => `<Bucket><Name>${esc(n)}</Name></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`
			)
		);
	}
	const bucket = r.bucket;
	const info = ctx.infra.bucketInfo(bucket);
	if (!info || info.jurisdiction !== r.jurisdiction) return finish(errorXml(404, 'NoSuchBucket', 'The specified bucket does not exist.', `/${bucket}`));

	const q = url.searchParams;
	const sub = (name: string) => q.has(name);
	if (R2_NOT_IMPLEMENTED.some(sub)) {
		if (f.r2NotImplemented) return finish(errorXml(501, 'NotImplemented', 'A header or query you provided requested a function that is not implemented.', resource));
		if (method === 'GET' && sub('versioning')) return finish(xmlResponse('<VersioningConfiguration/>'));
	}
	const address = bucketAddress(bucket);
	const writeRules = (conditionalHeader: boolean) => {
		const inm = req.headers.get('if-none-match');
		const honoured = f.conditionalWrites && (!presigned || f.conditionalOnPresigned);
		return {
			now,
			ifNoneMatch: conditionalHeader && honoured && inm?.trim() === '*',
			ifMatch: conditionalHeader && honoured ? (req.headers.get('if-match') ?? null) : null,
			rateLimit: f.perKeyWriteRateLimit
		};
	};

	// --- bucket level ------------------------------------------------------------
	if (!r.key) {
		if (method === 'HEAD') return finish(new Response(null, { status: allowed(cred, bucket, 'read') ? 200 : 403 }));
		if (method === 'GET') {
			if (!allowed(cred, bucket, 'read')) return finish(errorXml(403, 'AccessDenied', 'Access Denied', `/${bucket}`));
			if (sub('uploads')) {
				const ups = await ask<{ uploadId: string; key: string; initiatedAt: number }[]>(ctx.system, address, BUCKET_EVENTS.mpuList);
				return finish(listUploadsXml(bucket, ups));
			}
			const prefix = q.get('prefix') ?? '';
			const delimiter = q.get('delimiter') || null;
			const maxKeys = Math.min(Math.max(Number(q.get('max-keys') ?? 1000) || 1000, 1), 1000);
			const token = q.get('continuation-token');
			const startAfter = q.get('start-after');
			const after = token ? decodeContinuation(token) : startAfter;
			const result = await ask<ListResult>(ctx.system, address, BUCKET_EVENTS.list, { prefix, delimiter, maxKeys, after });
			return finish(listV2Xml(bucket, result, { prefix, delimiter, maxKeys, continuationToken: token, startAfter, urlEncode: q.get('encoding-type') === 'url' }));
		}
		if (method === 'POST' && sub('delete')) {
			if (!allowed(cred, bucket, 'write')) return finish(errorXml(403, 'AccessDenied', 'Access Denied', `/${bucket}`));
			const keys = [...new TextDecoder().decode(body).matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
			for (const key of keys) {
				const res = await ask<{ deletedBlobId: string | null }>(ctx.system, address, BUCKET_EVENTS.delete, { key });
				blobs.drop(res.deletedBlobId);
			}
			kind = { delete: true };
			return finish(xmlResponse(`<DeleteResult>${keys.map((k) => `<Deleted><Key>${esc(k)}</Key></Deleted>`).join('')}</DeleteResult>`));
		}
		// Bucket-scoped tokens cannot manage buckets (ADR 0095).
		return finish(errorXml(403, 'AccessDenied', 'Access Denied', `/${bucket}`));
	}

	// --- object level ------------------------------------------------------------
	const key = r.key;
	const needs: Access = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
	if (!allowed(cred, bucket, needs)) return finish(errorXml(403, 'AccessDenied', 'Access Denied', resource));

	if (method === 'POST' && sub('uploads')) {
		const uploadId = crypto.randomUUID().replace(/-/g, '');
		await ask(ctx.system, address, BUCKET_EVENTS.mpuCreate, { key, uploadId, now });
		return finish(initiateXml(bucket, key, uploadId));
	}
	if (method === 'PUT' && q.has('partNumber') && q.has('uploadId')) {
		if (req.headers.has('x-amz-copy-source')) return finish(errorXml(501, 'NotImplemented', 'UploadPartCopy is not implemented by fake-infra', resource));
		const bytes = corrupt ? blobs.corruptCopy(body) : body;
		const blobId = blobs.putBytes(bytes);
		const etag = blobs.md5(body);
		const res = await ask<{ etag: string; replacedBlobId: string | null } | S3Failure>(ctx.system, address, BUCKET_EVENTS.mpuPart, {
			uploadId: q.get('uploadId'),
			key,
			partNumber: Number(q.get('partNumber')),
			blobId,
			size: bytes.byteLength,
			etag
		});
		if (isFailure(res)) {
			blobs.drop(blobId);
			return finish(fromFailure(res as S3Failure, resource));
		}
		blobs.drop(res.replacedBlobId);
		return finish(new Response(null, { status: 200, headers: { ETag: `"${etag}"` } }));
	}
	if (method === 'POST' && q.has('uploadId')) {
		const parts = parseCompleteBody(new TextDecoder().decode(body));
		if (!parts) return finish(errorXml(400, 'MalformedXML', 'The XML you provided was not well-formed', resource));
		const res = await ask<{ key: string; etag: string; replacedBlobId: string | null; dropBlobIds: string[] } | S3Failure>(
			ctx.system,
			address,
			BUCKET_EVENTS.mpuComplete,
			{ uploadId: q.get('uploadId'), parts, equalPartSizes: f.equalPartSizes, ...writeRules(true) }
		);
		if (isFailure(res)) return finish(fromFailure(res as S3Failure, resource));
		blobs.drop(res.replacedBlobId);
		for (const id of res.dropBlobIds) blobs.drop(id);
		kind = { put: true };
		return finish(completeXml(`${url.origin}${url.pathname}`, bucket, key, res.etag));
	}
	if (method === 'DELETE' && q.has('uploadId')) {
		const res = await ask<{ dropBlobIds: string[] } | S3Failure>(ctx.system, address, BUCKET_EVENTS.mpuAbort, { uploadId: q.get('uploadId') });
		if (isFailure(res)) return finish(fromFailure(res as S3Failure, resource));
		for (const id of res.dropBlobIds) blobs.drop(id);
		return finish(new Response(null, { status: 204 }));
	}
	if (method === 'PUT') {
		if (req.headers.has('x-amz-copy-source')) return finish(errorXml(501, 'NotImplemented', 'CopyObject is not implemented by fake-infra', resource));
		const blobId = blobs.putBytes(corrupt ? blobs.corruptCopy(body) : body);
		const etag = blobs.md5(body);
		const res = await ask<{ etag: string; replacedBlobId: string | null } | S3Failure>(ctx.system, address, BUCKET_EVENTS.put, {
			key,
			blobId,
			size: body.byteLength,
			etag,
			...writeRules(true)
		});
		if (isFailure(res)) {
			blobs.drop(blobId);
			return finish(fromFailure(res as S3Failure, resource));
		}
		blobs.drop(res.replacedBlobId);
		kind = { put: true };
		return finish(new Response(null, { status: 200, headers: { ETag: `"${etag}"` } }));
	}
	if (method === 'DELETE') {
		const res = await ask<{ deletedBlobId: string | null }>(ctx.system, address, BUCKET_EVENTS.delete, { key });
		blobs.drop(res.deletedBlobId);
		kind = { delete: true };
		return finish(new Response(null, { status: 204 }));
	}
	if (method === 'GET' || method === 'HEAD') {
		const obj = await ask<StoredObject | null>(ctx.system, address, BUCKET_EVENTS.get, { key });
		if (!obj) {
			if (method === 'HEAD') return finish(new Response(null, { status: 404 }));
			return finish(errorXml(404, 'NoSuchKey', 'The specified key does not exist.', resource));
		}
		const quoted = `"${obj.etag}"`;
		const meta = { ETag: quoted, 'Last-Modified': httpDate(obj.lastModified), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
		const ifMatch = req.headers.get('if-match');
		if (ifMatch && ifMatch !== quoted && ifMatch !== obj.etag) return finish(errorXml(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold', resource));
		const inm = req.headers.get('if-none-match');
		if (inm && (inm === quoted || inm === obj.etag || inm === '*')) return finish(new Response(null, { status: 304, headers: meta }));
		if (method === 'HEAD') return finish(new Response(null, { status: 200, headers: { ...meta, 'Content-Length': String(obj.size) } }));
		let bytes = blobs.read(obj.blobId);
		if (corrupt) bytes = blobs.corruptCopy(bytes);
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
		if (range && (range[1] || range[2])) {
			const size = bytes.byteLength;
			const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
			const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
			if (start >= size || start > end) return finish(errorXml(416, 'InvalidRange', 'The requested range is not satisfiable', resource, { 'Content-Range': `bytes */${size}` }));
			const slice = bytes.subarray(start, end + 1);
			return finish(new Response(slice as Uint8Array<ArrayBuffer>, { status: 206, headers: { ...meta, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(slice.byteLength) } }));
		}
		return finish(new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...meta, 'Content-Length': String(bytes.byteLength) } }));
	}
	return finish(errorXml(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', resource));
}
