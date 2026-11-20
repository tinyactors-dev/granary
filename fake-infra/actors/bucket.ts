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
import { handlerChart } from '../../src/lib/charts';

export const BUCKET_FAMILY = 'bucket';
export const bucketAddress = (name: string) => `bucket/${name}`;

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
}

export const BUCKET_EVENTS = {
	put: 'object.put',
	get: 'object.get',
	delete: 'object.delete',
	list: 'object.list',
	mpuCreate: 'multipart.create',
	mpuPart: 'multipart.part',
	mpuComplete: 'multipart.complete',
	mpuCommit: 'multipart.commit',
	mpuAbort: 'multipart.abort',
	mpuList: 'multipart.list',
	seed: 'objects.seed'
} as const;

export interface S3Failure {
	error: string;
	status: number;
	code: string;
}
function fail(status: number, code: string, error: string): S3Failure {
	return { status, code, error };
}

/** Minimum size of every part but the last (S3 and R2). */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

function usedBytes(d: BucketData) {
	return Object.values(d.objects).reduce((n, o) => n + o.size, 0);
}

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

/**
 * `multipart.complete` checks the parts and answers the chosen ones (or a
 * failure); the server joins their bodies, which live outside the chart,
 * and `multipart.commit` stores the object.
 */
export interface CompleteChosen {
	key: string;
	size: number;
	parts: { size: number; etag: string; blobId: string }[];
}

export interface CommitEvent extends WriteRules {
	uploadId: string;
	key: string;
	size: number;
	etag: string;
	blobId: string;
}

export const bucketChart = handlerChart<BucketData>({
	name: BUCKET_FAMILY,
	initial: { name: '', jurisdiction: 'default', quotaBytes: null, objects: {}, uploads: {}, lastWrite: {} },
	helpers: { fail, usedBytes, checkWrite },
	handlers: {
		[BUCKET_EVENTS.put]: (d, e: PutEvent) => {
					const bad = checkWrite(d, e.key, e.size, e);
					if (bad) return bad;
					const replaced = d.objects[e.key]?.blobId ?? null;
					d.objects[e.key] = { key: e.key, size: e.size, etag: e.etag, lastModified: e.now, blobId: e.blobId };
					d.lastWrite[e.key] = e.now;
					return { etag: e.etag, replacedBlobId: replaced };
		},
		[BUCKET_EVENTS.get]: (d, e: { key: string }) => {
					const o = d.objects[e.key];
					return o ? { ...o } : null;
		},
		[BUCKET_EVENTS.delete]: (d, e: { key: string }) => {
					const o = d.objects[e.key];
					if (!o) return { deletedBlobId: null };
					delete d.objects[e.key];
					return { deletedBlobId: o.blobId };
		},
		[BUCKET_EVENTS.list]: (d, e: ListEvent): ListResult => {
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
		},
		[BUCKET_EVENTS.mpuCreate]: (d, e: { key: string; uploadId: string; now: number }) => {
					d.uploads[e.uploadId] = { uploadId: e.uploadId, key: e.key, initiatedAt: e.now, parts: {} };
					return { uploadId: e.uploadId };
		},
		[BUCKET_EVENTS.mpuPart]: (d, e: { uploadId: string; key: string; partNumber: number; blobId: string; size: number; etag: string }) => {
					const u = d.uploads[e.uploadId];
					if (!u || u.key !== e.key) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					if (e.partNumber < 1 || e.partNumber > 10_000) return fail(400, 'InvalidArgument', 'Part number must be between 1 and 10000');
					const replaced = u.parts[String(e.partNumber)]?.blobId ?? null;
					u.parts[String(e.partNumber)] = { size: e.size, etag: e.etag, blobId: e.blobId };
					return { etag: e.etag, replacedBlobId: replaced };
		},
		[BUCKET_EVENTS.mpuComplete]: (d, e: CompleteEvent) => {
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
						if (chosen[i]!.size < 5 * 1024 * 1024 /* MIN_PART_SIZE */) return fail(400, 'EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed object size.');
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
					const chosenResult: CompleteChosen = { key: u.key, size, parts: chosen.map((c) => ({ ...c })) };
					return chosenResult;
		},
		[BUCKET_EVENTS.mpuCommit]: (d, e: CommitEvent) => {
					const u = d.uploads[e.uploadId];
					if (!u) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					const bad = checkWrite(d, e.key, e.size, e);
					if (bad) return bad;
					const replaced = d.objects[e.key]?.blobId ?? null;
					const partBlobs = Object.values(u.parts).map((p) => p.blobId);
					d.objects[e.key] = { key: e.key, size: e.size, etag: e.etag, lastModified: e.now, blobId: e.blobId };
					d.lastWrite[e.key] = e.now;
					delete d.uploads[e.uploadId];
					return { key: e.key, etag: e.etag, size: e.size, replacedBlobId: replaced, dropBlobIds: partBlobs };
		},
		[BUCKET_EVENTS.mpuAbort]: (d, e: { uploadId: string }) => {
					const u = d.uploads[e.uploadId];
					if (!u) return fail(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
					delete d.uploads[e.uploadId];
					return { dropBlobIds: Object.values(u.parts).map((p) => p.blobId) };
		},
		[BUCKET_EVENTS.mpuList]: (d) =>
					Object.values(d.uploads).map((u) => ({ uploadId: u.uploadId, key: u.key, initiatedAt: u.initiatedAt, parts: Object.keys(u.parts).length })),
		[BUCKET_EVENTS.seed]: (d, e: { objects: { key: string; size: number; etag: string; lastModified: number; blobId: string }[] }) => {
					const replaced: string[] = [];
					for (const o of e.objects) {
						const prev = d.objects[o.key];
						if (prev) replaced.push(prev.blobId);
						d.objects[o.key] = { ...o };
					}
					return { seeded: e.objects.length, dropBlobIds: replaced };
		},
	}
});
