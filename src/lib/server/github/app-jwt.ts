/**
 * GitHub App authentication (ADR 0160, 0191): the RS256 app JWT and a cache
 * of installation access tokens.
 *
 * The JWT is signed with `node:crypto` (built into Bun). It accepts GitHub's
 * PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) as well as PKCS#8 directly, which
 * WebCrypto's `importKey` does not (ADR 0191).
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A short-lived app JWT: `iat = now - 60 s`, `exp = now + 9 min`, `iss = appId`. */
export function appJwt(appId: number, privateKey: string | KeyObject, now = Date.now()): string {
	const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
	const iat = Math.floor(now / 1000) - 60;
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = b64url(JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: String(appId) }));
	const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
	return `${header}.${payload}.${b64url(signature)}`;
}

/** Validate a PEM early (manifest completion, seeds) with a readable error. */
export function checkPrivateKey(pem: string): KeyObject {
	try {
		const key = createPrivateKey(pem);
		if (key.asymmetricKeyType !== 'rsa') throw new Error(`expected an RSA key, got ${key.asymmetricKeyType}`);
		return key;
	} catch (e) {
		throw new Error(`GitHub App private key is not a usable RSA PEM: ${(e as Error).message}`);
	}
}

export interface CachedToken {
	token: string;
	expiresAt: number;
}

/**
 * Installation tokens, cached per installation until 5 minutes before
 * `expires_at`; concurrent callers share one in-flight request.
 */
export class InstallationTokenCache {
	readonly #fetch: (installationId: number) => Promise<CachedToken>;
	readonly #skewMs: number;
	#tokens = new Map<number, CachedToken>();
	#inflight = new Map<number, Promise<CachedToken>>();

	constructor(fetchToken: (installationId: number) => Promise<CachedToken>, skewMs = 5 * 60_000) {
		this.#fetch = fetchToken;
		this.#skewMs = skewMs;
	}

	async get(installationId: number, now = Date.now()): Promise<string> {
		const cached = this.#tokens.get(installationId);
		if (cached && cached.expiresAt - this.#skewMs > now) return cached.token;
		let p = this.#inflight.get(installationId);
		if (!p) {
			p = this.#fetch(installationId).finally(() => this.#inflight.delete(installationId));
			this.#inflight.set(installationId, p);
		}
		const fresh = await p;
		this.#tokens.set(installationId, fresh);
		return fresh.token;
	}

	/** Drop a token GitHub rejected (401) so the next call fetches a new one. */
	invalidate(installationId: number): void {
		this.#tokens.delete(installationId);
	}

	clear(): void {
		this.#tokens.clear();
	}
}
