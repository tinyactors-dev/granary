/**
 * `bucket/<name>` — one S3/R2 bucket (ADR 0131): object metadata, in-flight
 * multipart uploads, quota and R2's write rules. Bodies live in `../blobs`
 * (the actor holds blob ids). Buckets are created only via the control API
 * (ops never creates buckets, ADR 0095).
 *
 * Failures are `{error, status, code}` where `code` is the S3 error code the
 * server renders as XML (`PreconditionFailed`, `SlowDown`, `NoSuchUpload`,
 * `InvalidPart`, `EntityTooSmall`, `QuotaExceeded`, …).
 */
import { statechart } from '@tinyactors/node';
import * as blobs from '../blobs';
import { answer } from '../io/reply';

export const BUCKET_FAMILY = 'bucket';
export const bucketAddress = (name: string) => ({ family: BUCKET_FAMILY, name });

export type Jurisdiction = 'default' | 'eu' | 'fedramp';

export interface StoredObject {
	key: string;
	size: number;
	etag: string;
	lastModified: number;
	blobId: string;
}

export interface Upload {
	uploadId: string;
	key: string;
	initiatedAt: number;
	parts: Record<string, { size: number; etag: string; blobId: string }>;
}

export interface BucketData {
	name: string;
	jurisdiction: Jurisdiction;
	quotaBytes: number | null;
	objects: Record<string, StoredObject>;
	uploads: Record<string, Upload>;
	/** Last successful write per key (R2's 1 write/s/key limit). */
	lastWrite: Record<string, number>;
	out: unknown;
}

export const BUCKET_EVENTS = {
	put: 'object.put',
	get: 'object.get',
	delete: 'object.delete',
	list: 'object.list',
	mpuCreate: 'multipart.create',
	mpuPart: 'multipart.part',
	mpuComplete: 'multipart.complete',
	mpuAbort: 'multipart.abort',
	mpuList: 'multipart.list',
	seed: 'objects.seed'
} as const;

export interface S3Failure {
	error: string;
	status: number;
	code: string;
}
const fail = (status: number, code: string, error: string): S3Failure => ({ status, code, error });

/** Minimum size of every part but the last (S3 and R2). */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

const usedBytes = (d: BucketData) => Object.values(d.objects).reduce((n, o) => n + o.size, 0);

interface WriteRules {
	now: number;
	ifNoneMatch: boolean;
	ifMatch: string | null;
	rateLimit: boolean;
}

/** Shared precondition/rate/quota checks for a write of `size` bytes to `key`. */
function checkWrite(d: BucketData, key: string, size: number, r: WriteRules): S3Failure | null {
	const existing = d.objects[key];
	if (r.ifNoneMatch && existing) return fail(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
	if (r.ifMatch !== null && (!existing || `"${existing.etag}"` !== r.ifMatch.trim() && existing.etag !== r.ifMatch.trim()))
		return fail(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
	if (r.rateLimit) {
		const last = d.lastWrite[key];
		if (last !== undefined && r.now - last < 1000) return fail(429, 'SlowDown', 'Reduce your concurrent request rate for the same object.');
	}
	if (d.quotaBytes !== null) {
		const after = usedBytes(d) - (existing?.size ?? 0) + size;
		if (after > d.quotaBytes) return fail(507, 'QuotaExceeded', `Bucket quota of ${d.quotaBytes} bytes exceeded`);
	}
	return null;
}

export interface PutEvent extends WriteRules {
	key: string;
	blobId: string;
	size: number;
	etag: string;
}

export interface ListEvent {
	prefix: string;
	delimiter: string | null;
	maxKeys: number;
	/** Exclusive start key (continuation token / start-after). */
	after: string | null;
}

export interface ListResult {
	contents: Omit<StoredObject, 'blobId'>[];
	commonPrefixes: string[];
	truncated: boolean;
	nextAfter: string | null;
}

export interface CompleteEvent extends WriteRules {
	uploadId: string;
	parts: { partNumber: number; etag: string }[];
	equalPartSizes: boolean;
}

export const bucketChart = statechart<BucketData>({ family: BUCKET_FAMILY, revision: 'v1' })
	.data('name', '')
	.data('jurisdiction', 'default')
	.data('quotaBytes', null)
	.dataExpression('objects', () => ({}))
	.dataExpression('uploads', () => ({}))
	.dataExpression('lastWrite', () => ({}))
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				BUCKET_EVENTS.put,
				answer<BucketData, PutEvent>((d, e) => {
					const bad = checkWrite(d, e.key, e.size, e);
					if (bad) return bad;
					const replaced = d.objects[e.key]?.blobId ?? null;
					d.objects[e.key] = { key: e.key, size: e.size, etag: e.etag, lastModified: e.now, blobId: e.blobId };
					d.lastWrite[e.key] = e.now;
					return { etag: e.etag, replacedBlobId: replaced };
				})
			)
			.on(
				BUCKET_EVENTS.get,
				answer<BucketData, { key: string }>((d, e) => {
					const o = d.objects[e.key];
					return o ? { ...o } : null;
				})
			)
			.on(
				BUCKET_EVENTS.delete,
				answer<BucketData, { key: string }>((d, e) => {
					const o = d.objects[e.key];
					if (!o) return { deletedBlobId: null };
					delete d.objects[e.key];
					return { deletedBlobId: o.blobId };
				})
			)
			.on(
				BUCKET_EVENTS.list,
				answer<BucketData, ListEvent>((d, e): ListResult => {
					const keys = Object.keys(d.objects)
						.filter((k) => k.startsWith(e.prefix) && (e.after === null || k > e.after))
						.sort();
					const contents: ListResult['contents'] = [];
					const prefixes = new Set<string>();
					let last: string | null = null;
					let truncated = false;
					for (const k of keys) {
						if (contents.length + prefixes.size >= e.maxKeys) {
							truncated = true;
							break;
						}
						last = k;
						if (e.delimiter) {
							const i = k.indexOf(e.delimiter, e.prefix.length);
							if (i >= 0) {
								prefixes.add(k.slice(0, i + e.delimiter.length));
								continue;
							}
						}
						const { blobId: _b, ...meta } = d.objects[k]!;
						contents.push(meta);
					}
					return { contents, commonPrefixes: [...prefixes].sort(), truncated, nextAfter: truncated ? last : null };
				})
			)
			.on(
				BUCKET_EVENTS.mpuCreate,
				answer<BucketData, { key: string; uploadId: string; now: number }>((d, e) => {
					d.uploads[e.uploadId] = { uploadId: e.uploadId, key: e.key, initiatedAt: e.now, parts: {} };
					return { uploadId: e.uploadId };
				})
			)
			.on(
				BUCKET_EVENTS.mpuPart,
				answer<BucketData, { uploadId: string; key: string; partNumber: number; blobId: string; size: number; etag: string }>((d, e) => {
					const u = d.uploads[e.uploadId];
					if (!u || u.key !== e.key) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					if (e.partNumber < 1 || e.partNumber > 10_000) return fail(400, 'InvalidArgument', 'Part number must be between 1 and 10000');
					const replaced = u.parts[String(e.partNumber)]?.blobId ?? null;
					u.parts[String(e.partNumber)] = { size: e.size, etag: e.etag, blobId: e.blobId };
					return { etag: e.etag, replacedBlobId: replaced };
				})
			)
			.on(
				BUCKET_EVENTS.mpuComplete,
				answer<BucketData, CompleteEvent>((d, e) => {
					const u = d.uploads[e.uploadId];
					if (!u) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					if (!e.parts.length) return fail(400, 'MalformedXML', 'You must specify at least one part');
					const chosen: { size: number; etag: string; blobId: string }[] = [];
					let prev = 0;
					for (const p of e.parts) {
						if (p.partNumber <= prev) return fail(400, 'InvalidPartOrder', 'The list of parts was not in ascending order.');
						prev = p.partNumber;
						const stored = u.parts[String(p.partNumber)];
						const want = p.etag.replaceAll('"', '');
						if (!stored || stored.etag !== want) return fail(400, 'InvalidPart', `Part ${p.partNumber} was not found or its ETag does not match.`);
						chosen.push(stored);
					}
					for (let i = 0; i < chosen.length - 1; i++) {
						if (chosen[i]!.size < MIN_PART_SIZE) return fail(400, 'EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed object size.');
					}
					if (e.equalPartSizes && chosen.length > 2) {
						const first = chosen[0]!.size;
						if (chosen.slice(0, -1).some((c) => c.size !== first))
							return fail(400, 'InvalidPart', 'All non-trailing parts must have the same length.');
					}
					if (e.equalPartSizes && chosen.length >= 2 && chosen[chosen.length - 1]!.size > chosen[0]!.size)
						return fail(400, 'InvalidPart', 'The trailing part must not be larger than the other parts.');
					const size = chosen.reduce((n, c) => n + c.size, 0);
					const bad = checkWrite(d, u.key, size, e);
					if (bad) return bad;
					const md5s = new Uint8Array(chosen.length * 16);
					chosen.forEach((c, i) => md5s.set(Buffer.from(c.etag, 'hex'), i * 16));
					const etag = `${blobs.md5(md5s)}-${chosen.length}`;
					const blobId = blobs.concat(chosen.map((c) => c.blobId));
					const replaced = d.objects[u.key]?.blobId ?? null;
					const partBlobs = Object.values(u.parts).map((p) => p.blobId);
					d.objects[u.key] = { key: u.key, size, etag, lastModified: e.now, blobId };
					d.lastWrite[u.key] = e.now;
					delete d.uploads[e.uploadId];
					return { key: u.key, etag, size, replacedBlobId: replaced, dropBlobIds: partBlobs };
				})
			)
			.on(
				BUCKET_EVENTS.mpuAbort,
				answer<BucketData, { uploadId: string }>((d, e) => {
					const u = d.uploads[e.uploadId];
					if (!u) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					delete d.uploads[e.uploadId];
					return { dropBlobIds: Object.values(u.parts).map((p) => p.blobId) };
				})
			)
			.on(
				BUCKET_EVENTS.mpuList,
				answer<BucketData>((d) =>
					Object.values(d.uploads).map((u) => ({ uploadId: u.uploadId, key: u.key, initiatedAt: u.initiatedAt, parts: Object.keys(u.parts).length }))
				)
			)
			.on(
				BUCKET_EVENTS.seed,
				answer<BucketData, { objects: { key: string; size: number; etag: string; lastModified: number; blobId: string }[] }>((d, e) => {
					const replaced: string[] = [];
					for (const o of e.objects) {
						const prev = d.objects[o.key];
						if (prev) replaced.push(prev.blobId);
						d.objects[o.key] = { ...o };
					}
					return { seeded: e.objects.length, dropBlobIds: replaced };
				})
			)
	);
