/**
 * AWS Signature Version 4 verification for the fake S3/R2 surface (ADR 0131).
 * Supports header auth (`Authorization: AWS4-HMAC-SHA256 …`) and presigned
 * URLs (`X-Amz-Algorithm` … in the query), the two forms Bun's S3 client
 * produces. Canonical URI: every path segment decoded, then RFC 3986 encoded
 * once (S3 does not double-encode).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SigV4Auth {
	accessKeyId: string;
	/** YYYYMMDD from the credential scope. */
	scopeDate: string;
	region: string;
	service: string;
	signedHeaders: string[];
	signature: string;
	/** YYYYMMDDTHHMMSSZ */
	amzDate: string;
	presigned: boolean;
	/** Presigned URLs only, seconds. */
	expires: number | null;
	payloadHash: string;
}

export type ParseResult = { ok: true; auth: SigV4Auth } | { ok: false; code: string; message: string } | { ok: 'anonymous' };

const ALGO = 'AWS4-HMAC-SHA256';

/** RFC 3986 encoding, as SigV4 requires. */
export const rfc3986 = (s: string) =>
	encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

export function parseAuth(req: Request, url: URL): ParseResult {
	const q = url.searchParams;
	if (q.get('X-Amz-Algorithm')) {
		if (q.get('X-Amz-Algorithm') !== ALGO) return { ok: false, code: 'AuthorizationQueryParametersError', message: 'Unsupported algorithm' };
		const cred = (q.get('X-Amz-Credential') ?? '').split('/');
		const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
		const signature = q.get('X-Amz-Signature') ?? '';
		const amzDate = q.get('X-Amz-Date') ?? '';
		const expires = Number(q.get('X-Amz-Expires') ?? 'NaN');
		if (cred.length !== 5 || !signature || !amzDate || !Number.isFinite(expires))
			return { ok: false, code: 'AuthorizationQueryParametersError', message: 'Malformed presigned query' };
		return {
			ok: true,
			auth: {
				accessKeyId: cred[0]!,
				scopeDate: cred[1]!,
				region: cred[2]!,
				service: cred[3]!,
				signedHeaders,
				signature,
				amzDate,
				presigned: true,
				expires,
				payloadHash: 'UNSIGNED-PAYLOAD'
			}
		};
	}
	const header = req.headers.get('authorization');
	if (!header) return { ok: 'anonymous' };
	if (!header.startsWith(`${ALGO} `)) return { ok: false, code: 'InvalidArgument', message: 'Unsupported Authorization type' };
	const fields = Object.fromEntries(
		header
			.slice(ALGO.length + 1)
			.split(',')
			.map((p) => p.trim().split('=') as [string, string])
	);
	const cred = (fields.Credential ?? '').split('/');
	const amzDate = req.headers.get('x-amz-date') ?? '';
	if (cred.length !== 5 || !fields.SignedHeaders || !fields.Signature || !amzDate)
		return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'The authorization header is malformed' };
	return {
		ok: true,
		auth: {
			accessKeyId: cred[0]!,
			scopeDate: cred[1]!,
			region: cred[2]!,
			service: cred[3]!,
			signedHeaders: fields.SignedHeaders.split(';'),
			signature: fields.Signature,
			amzDate,
			presigned: false,
			expires: null,
			payloadHash: req.headers.get('x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD'
		}
	};
}

/** `YYYYMMDDTHHMMSSZ` → epoch ms (NaN when malformed). */
export function amzDateToMs(s: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
	if (!m) return NaN;
	return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function canonicalUri(pathname: string): string {
	return pathname
		.split('/')
		.map((seg) => rfc3986(safeDecode(seg)))
		.join('/');
}

function canonicalQuery(url: URL, presigned: boolean): string {
	const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
	const pairs: [string, string][] = [];
	for (const part of raw.split('&')) {
		if (!part) continue;
		const i = part.indexOf('=');
		const k = safeDecode((i < 0 ? part : part.slice(0, i)).replace(/\+/g, '%20'));
		const v = i < 0 ? '' : safeDecode(part.slice(i + 1).replace(/\+/g, '%20'));
		if (presigned && k === 'X-Amz-Signature') continue;
		pairs.push([rfc3986(k), rfc3986(v)]);
	}
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
	return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export function computeSignature(req: Request, url: URL, auth: SigV4Auth, secret: string): string {
	const headers = auth.signedHeaders
		.map((h) => {
			const v = h === 'host' ? (req.headers.get('host') ?? url.host) : (req.headers.get(h) ?? '');
			return `${h}:${v.trim().replace(/\s+/g, ' ')}\n`;
		})
		.join('');
	const canonical = [
		req.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQuery(url, auth.presigned),
		headers,
		auth.signedHeaders.join(';'),
		auth.payloadHash
	].join('\n');
	const scope = `${auth.scopeDate}/${auth.region}/${auth.service}/aws4_request`;
	const toSign = [ALGO, auth.amzDate, scope, sha256hex(canonical)].join('\n');
	const kDate = hmac(`AWS4${secret}`, auth.scopeDate);
	const kRegion = hmac(kDate, auth.region);
	const kService = hmac(kRegion, auth.service);
	const kSigning = hmac(kService, 'aws4_request');
	return createHmac('sha256', kSigning).update(toSign).digest('hex');
}

export function signatureMatches(req: Request, url: URL, auth: SigV4Auth, secret: string): boolean {
	const expected = Buffer.from(computeSignature(req, url, auth, secret), 'hex');
	const given = Buffer.from(auth.signature, 'hex');
	return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Does a signed body hash (when the client sent a real one) match the body? */
export function payloadMatches(auth: SigV4Auth, body: Uint8Array): boolean {
	const h = auth.payloadHash;
	if (h === 'UNSIGNED-PAYLOAD' || h.startsWith('STREAMING-')) return true;
	return sha256hex(body) === h;
}
