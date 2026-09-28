/**
 * Object store adapters for backup destinations (ADR 0084, 0095, 0098, 0106).
 *
 * `r2` and `s3` use Bun's built-in S3Client (prefer-Bun rule); the manifest
 * commit marker is written create-once through a presigned PUT with
 * `If-None-Match: *` (Bun's client can't send conditional headers), falling
 * back to HEAD-then-PUT only when the provider rejects the conditional header
 * as unsupported (ADR 0095, 0112). `local-dir` writes files under a directory
 * on the VM disk (create-once via O_EXCL).
 */
import { S3Client } from 'bun';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DestinationSettings } from '../schemas/destinations';
import { R2_REGION, UPLOAD_TUNING, r2Endpoint } from '../schemas/destinations';
import type { StoreError, StoreErrorCode } from '../schemas/runs';

export interface StoreObject {
	key: string;
	size: number;
	lastModified: number;
}

export interface BackupStore {
	readonly kind: DestinationSettings['kind'];
	/** Derived endpoint (shown in test connection, ADR 0106); null for local-dir. */
	readonly endpoint: string | null;
	readonly prefix: string;
	/** Off-site = billed egress when uploading (ADR 0107). */
	readonly offsite: boolean;
	putStream(key: string, chunks: AsyncIterable<Uint8Array>, contentType: string, onBytes?: (n: number) => void): Promise<number>;
	putText(key: string, body: string, contentType: string): Promise<void>;
	/** Create-once. 'exists' when the key is already present (412 / EEXIST). */
	putIfAbsent(key: string, body: string, contentType: string): Promise<'created' | 'exists'>;
	getStream(key: string): Promise<ReadableStream<Uint8Array>>;
	getText(key: string): Promise<string | null>;
	head(key: string): Promise<StoreObject | null>;
	list(prefix: string): Promise<StoreObject[]>;
	delete(key: string): Promise<void>;
	/** Short-lived download URL; null when the kind has none (local-dir). */
	presignGet(key: string, expiresInSec: number): string | null;
}

/** An error carrying a classified StoreError (ADR 0082: `store.error {code, retryable}`). */
export class StoreFailure extends Error {
	readonly error: StoreError;
	constructor(error: StoreError) {
		super(error.message);
		this.name = 'StoreFailure';
		this.error = error;
	}
}

const RETRYABLE: Record<StoreErrorCode, boolean> = {
	auth: false,
	'no-bucket': false,
	'clock-skew': false,
	'rate-limited': true,
	quota: false,
	conflict: false,
	server: true,
	network: true,
	integrity: true,
	other: true
};

export function storeError(code: StoreErrorCode, message: string, extra: Partial<StoreError> = {}): StoreError {
	return { code, retryable: RETRYABLE[code], status: null, providerCode: null, retryAfterMs: null, ...extra, message };
}

/** Map an S3 provider code / HTTP status to our classification. */
export function classify(providerCode: string | null, status: number | null, message: string): StoreError {
	const pc = providerCode ?? '';
	let code: StoreErrorCode;
	if (/SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|InvalidToken|ExpiredToken|Unauthorized/i.test(pc) || status === 401 || status === 403) code = 'auth';
	else if (/NoSuchBucket/i.test(pc)) code = 'no-bucket';
	else if (/RequestTimeTooSkewed/i.test(pc)) code = 'clock-skew';
	else if (/SlowDown|TooManyRequests|RequestLimitExceeded/i.test(pc) || status === 429 || status === 503) code = 'rate-limited';
	else if (/QuotaExceeded|EntityTooLarge|InsufficientStorage|XMinioStorageFull|StorageFull/i.test(pc) || status === 507) code = 'quota';
	else if (/PreconditionFailed/i.test(pc) || status === 412) code = 'conflict';
	else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ConnectionRefused|ConnectionClosed|network|socket|fetch failed|timed out/i.test(`${pc} ${message}`)) code = 'network';
	else if ((status ?? 0) >= 500 || /InternalError|ServiceUnavailable/i.test(pc)) code = 'server';
	else code = 'other';
	return storeError(code, message, { status, providerCode: providerCode || null });
}

/** Normalise anything thrown by Bun.S3Client / fetch / fs into a StoreFailure. */
export function toStoreFailure(e: unknown, op: string): StoreFailure {
	if (e instanceof StoreFailure) return e;
	const err = e as { name?: string; code?: string; message?: string; status?: number; errno?: number };
	const message = `${op}: ${err?.message ?? String(e)}`.slice(0, 500);
	if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') return new StoreFailure(storeError('quota', message, { providerCode: err.code }));
	const status = typeof err?.status === 'number' ? err.status : null;
	return new StoreFailure(classify(err?.code ?? err?.name ?? null, status, message));
}

async function failIfNotOk(res: Response, op: string): Promise<void> {
	if (res.ok) return;
	const text = await res.text().catch(() => '');
	const providerCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
	const retryAfter = res.headers.get('retry-after');
	const e = classify(providerCode, res.status, `${op}: HTTP ${res.status} ${providerCode ?? ''} ${(/<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? '').slice(0, 200)}`.trim());
	if (retryAfter && /^\d+$/.test(retryAfter)) e.retryAfterMs = Number(retryAfter) * 1000;
	throw new StoreFailure(e);
}

/** Open a store for a destination. `secret` resolves the secretAccessKey ref at the moment of use. */
export async function openStore(settings: DestinationSettings, opts: { secret: (ref: string) => Promise<string>; dataDir: string }): Promise<BackupStore> {
	if (settings.kind === 'local-dir') {
		const root = isAbsolute(settings.path) ? settings.path : join(opts.dataDir, settings.path);
		return new LocalDirStore(root);
	}
	const endpoint = (settings.kind === 'r2' ? (settings.endpointOverride ?? r2Endpoint(settings.accountId, settings.jurisdiction)) : settings.endpoint).replace(/\/+$/, '');
	const region = settings.kind === 'r2' ? R2_REGION : settings.region;
	const secretAccessKey = await opts.secret(settings.secretAccessKey.secretRef);
	return new S3Store(settings.kind, {
		endpoint,
		region,
		bucket: settings.bucket,
		accessKeyId: settings.accessKeyId,
		secretAccessKey,
		virtualHostedStyle: settings.kind === 's3' ? settings.virtualHostedStyle : false
	}, settings.prefix);
}

class S3Store implements BackupStore {
	readonly offsite = true;
	readonly endpoint: string;
	readonly #client: S3Client;
	#conditionalUnsupported = false;

	constructor(
		readonly kind: 'r2' | 's3',
		o: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; virtualHostedStyle: boolean },
		readonly prefix: string
	) {
		this.endpoint = o.endpoint;
		this.#client = new S3Client({ ...o });
	}

	async putStream(key: string, chunks: AsyncIterable<Uint8Array>, contentType: string, onBytes?: (n: number) => void): Promise<number> {
		const w = this.#client.file(key, { type: contentType }).writer({ partSize: UPLOAD_TUNING.partSize, queueSize: UPLOAD_TUNING.queueSize, retry: UPLOAD_TUNING.retry, type: contentType });
		let total = 0;
		try {
			for await (const c of chunks) {
				await w.write(c);
				total += c.length;
				onBytes?.(c.length);
			}
			await w.end();
		} catch (e) {
			try {
				await w.end(e instanceof Error ? e : new Error(String(e)));
			} catch {
				/* aborting the multipart upload is best effort; R2's lifecycle rule cleans up (ADR 0095) */
			}
			throw toStoreFailure(e, `PUT ${key}`);
		}
		// Bun's multipart writer can resolve after it aborted the upload (a part failed all its
		// retries; observed against fake-infra, ADR 0112). Never trust it: the object must exist
		// with exactly the bytes we streamed before anyone commits a manifest for it.
		const h = await this.head(key);
		if (!h || h.size !== total) {
			throw new StoreFailure(storeError('integrity', `PUT ${key}: upload reported success but the object is ${h ? `${h.size} bytes` : 'missing'} (streamed ${total})`));
		}
		return total;
	}

	async putText(key: string, body: string, contentType: string): Promise<void> {
		try {
			await this.#client.write(key, body, { type: contentType });
		} catch (e) {
			throw toStoreFailure(e, `PUT ${key}`);
		}
	}

	async putIfAbsent(key: string, body: string, contentType: string): Promise<'created' | 'exists'> {
		if (!this.#conditionalUnsupported) {
			let res: Response;
			try {
				const url = this.#client.presign(key, { method: 'PUT', expiresIn: 300, type: contentType });
				res = await fetch(url, { method: 'PUT', body, headers: { 'If-None-Match': '*', 'Content-Type': contentType } });
			} catch (e) {
				throw toStoreFailure(e, `PUT(If-None-Match) ${key}`);
			}
			if (res.status === 412) {
				await res.text().catch(() => '');
				return 'exists';
			}
			if (res.status === 501 || res.status === 400) {
				const text = await res.text().catch(() => '');
				if (/NotImplemented|InvalidArgument|conditional/i.test(text)) this.#conditionalUnsupported = true;
				else await failIfNotOk(new Response(text, { status: res.status, headers: res.headers }), `PUT(If-None-Match) ${key}`);
			} else {
				await failIfNotOk(res, `PUT(If-None-Match) ${key}`);
				await res.text().catch(() => '');
				return 'created';
			}
		}
		// Fallback (ADR 0095): HEAD-then-PUT; the upload actor is the single writer per key.
		if (await this.head(key)) return 'exists';
		await this.putText(key, body, contentType);
		return 'created';
	}

	async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
		try {
			const f = this.#client.file(key);
			await f.stat(); // surface NoSuchKey / auth before streaming
			return f.stream() as ReadableStream<Uint8Array>;
		} catch (e) {
			throw toStoreFailure(e, `GET ${key}`);
		}
	}

	async getText(key: string): Promise<string | null> {
		try {
			return await this.#client.file(key).text();
		} catch (e) {
			const f = toStoreFailure(e, `GET ${key}`);
			if (/NoSuchKey/.test(f.error.providerCode ?? '') || f.error.status === 404) return null;
			throw f;
		}
	}

	async head(key: string): Promise<StoreObject | null> {
		try {
			const s = await this.#client.file(key).stat();
			return { key, size: s.size, lastModified: s.lastModified.getTime() };
		} catch (e) {
			const err = e as { code?: string };
			if (err?.code === 'NoSuchKey' || err?.code === 'NotFound' || /404|not found/i.test(String((e as Error)?.message))) return null;
			throw toStoreFailure(e, `HEAD ${key}`);
		}
	}

	async list(prefix: string): Promise<StoreObject[]> {
		const out: StoreObject[] = [];
		let token: string | undefined;
		try {
			for (let page = 0; page < 10_000; page++) {
				const r = await this.#client.list({ prefix, maxKeys: 1000, ...(token ? { continuationToken: token } : {}) });
				for (const c of r.contents ?? []) out.push({ key: c.key, size: c.size ?? 0, lastModified: c.lastModified ? Date.parse(c.lastModified) : 0 });
				if (!r.isTruncated || !r.nextContinuationToken) break;
				token = r.nextContinuationToken;
			}
			return out;
		} catch (e) {
			throw toStoreFailure(e, `LIST ${prefix}`);
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.#client.delete(key);
		} catch (e) {
			const f = toStoreFailure(e, `DELETE ${key}`);
			if (/NoSuchKey/.test(f.error.providerCode ?? '')) return;
			throw f;
		}
	}

	presignGet(key: string, expiresInSec: number): string {
		return this.#client.presign(key, { method: 'GET', expiresIn: expiresInSec });
	}
}

class LocalDirStore implements BackupStore {
	readonly kind = 'local-dir' as const;
	readonly endpoint = null;
	readonly prefix = '';
	readonly offsite = false;
	constructor(readonly root: string) {}

	#path(key: string): string {
		const p = join(this.root, key);
		if (relative(this.root, p).startsWith('..')) throw new StoreFailure(storeError('other', `key escapes the destination directory: ${key}`));
		return p;
	}

	async putStream(key: string, chunks: AsyncIterable<Uint8Array>, _ct: string, onBytes?: (n: number) => void): Promise<number> {
		const p = this.#path(key);
		const partial = `${p}.partial`;
		try {
			await mkdir(dirname(p), { recursive: true });
			const fh = await open(partial, 'w', 0o600);
			let total = 0;
			try {
				for await (const c of chunks) {
					await fh.write(c);
					total += c.length;
					onBytes?.(c.length);
				}
				await fh.sync();
			} finally {
				await fh.close();
			}
			await rename(partial, p);
			return total;
		} catch (e) {
			await rm(partial, { force: true });
			throw toStoreFailure(e, `write ${key}`);
		}
	}

	async putText(key: string, body: string): Promise<void> {
		const p = this.#path(key);
		try {
			await mkdir(dirname(p), { recursive: true });
			await writeFile(p, body, { mode: 0o600 });
		} catch (e) {
			throw toStoreFailure(e, `write ${key}`);
		}
	}

	async putIfAbsent(key: string, body: string): Promise<'created' | 'exists'> {
		const p = this.#path(key);
		try {
			await mkdir(dirname(p), { recursive: true });
			const fh = await open(p, 'wx', 0o600);
			try {
				await fh.writeFile(body);
				await fh.sync();
			} finally {
				await fh.close();
			}
			return 'created';
		} catch (e) {
			if ((e as { code?: string }).code === 'EEXIST') return 'exists';
			throw toStoreFailure(e, `write ${key}`);
		}
	}

	async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
		const p = this.#path(key);
		if (!(await Bun.file(p).exists())) throw new StoreFailure(storeError('other', `GET ${key}: no such file`, { providerCode: 'NoSuchKey', status: 404 }));
		return Bun.file(p).stream() as ReadableStream<Uint8Array>;
	}

	async getText(key: string): Promise<string | null> {
		const f = Bun.file(this.#path(key));
		return (await f.exists()) ? f.text() : null;
	}

	async head(key: string): Promise<StoreObject | null> {
		try {
			const s = await stat(this.#path(key));
			return { key, size: s.size, lastModified: s.mtimeMs };
		} catch {
			return null;
		}
	}

	async list(prefix: string): Promise<StoreObject[]> {
		const out: StoreObject[] = [];
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else if (e.isFile() && !e.name.endsWith('.partial')) {
					const key = relative(this.root, full).split(sep).join('/');
					if (key.startsWith(prefix)) {
						const s = await stat(full);
						out.push({ key, size: s.size, lastModified: s.mtimeMs });
					}
				}
			}
		};
		await walk(this.root);
		return out;
	}

	async delete(key: string): Promise<void> {
		await rm(this.#path(key), { force: true });
	}

	presignGet(): null {
		return null;
	}
}
