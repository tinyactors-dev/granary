/**
 * Real crypto for the fake GitHub App surface (ADR 0164, ADR 0201):
 * RSA key pairs for new apps and RS256 JWT verification with GitHub's rules.
 *
 * The private key is returned ONCE by the manifest conversion as a PKCS#1
 * PEM (`-----BEGIN RSA PRIVATE KEY-----`), exactly like github.com, so the
 * app side must handle that format. The fake only keeps the public key.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

export interface AppKeyPair {
	/** PKCS#1 PEM, as GitHub returns it in `pem`. */
	privateKeyPem: string;
	/** SPKI PEM, kept by the fake to verify JWTs. */
	publicKeyPem: string;
}

export function generateAppKeyPair(): AppKeyPair {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
	});
	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** GitHub's allowances (docs: "Generating a JSON Web Token for a GitHub App"). */
export const JWT_MAX_LIFETIME_S = 600;
export const JWT_CLOCK_SKEW_S = 60;

export interface JwtClaims {
	iss: string | number;
	iat: number;
	exp: number;
	[k: string]: unknown;
}

export type JwtCheck =
	| { ok: true; claims: JwtClaims }
	| { ok: false; message: string };

const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Split and decode a JWT without verifying it (to find `iss`). */
export function peekJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	try {
		return {
			header: JSON.parse(b64urlDecode(parts[0]!).toString('utf8')) as Record<string, unknown>,
			claims: JSON.parse(b64urlDecode(parts[1]!).toString('utf8')) as Record<string, unknown>
		};
	} catch {
		return null;
	}
}

export const looksLikeJwt = (token: string) => token.split('.').length === 3 && token.startsWith('eyJ');

/**
 * Verify an app JWT: RS256 signature with `publicKeyPem`, `iat` not in the
 * future (beyond skew), `exp` in the future and at most 10 minutes (+skew)
 * ahead. Messages mirror GitHub's 401 bodies.
 */
export function verifyAppJwt(token: string, publicKeyPem: string, nowMs = Date.now()): JwtCheck {
	const parts = token.split('.');
	const decoded = peekJwt(token);
	if (!decoded || parts.length !== 3) return { ok: false, message: 'A JSON web token could not be decoded' };
	if (decoded.header.alg !== 'RS256') return { ok: false, message: "'alg' must be RS256" };
	const valid = verify(
		'RSA-SHA256',
		Buffer.from(`${parts[0]}.${parts[1]}`),
		createPublicKey(publicKeyPem),
		b64urlDecode(parts[2]!)
	);
	if (!valid) return { ok: false, message: 'A JSON web token could not be decoded' };
	const { iat, exp } = decoded.claims;
	const now = Math.floor(nowMs / 1000);
	if (typeof iat !== 'number' || !Number.isInteger(iat) || iat > now + JWT_CLOCK_SKEW_S) {
		return { ok: false, message: "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued" };
	}
	if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= now) {
		return { ok: false, message: "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires" };
	}
	if (exp > now + JWT_MAX_LIFETIME_S + JWT_CLOCK_SKEW_S) {
		return { ok: false, message: "'Expiration time' claim ('exp') is too far in the future" };
	}
	return { ok: true, claims: decoded.claims as JwtClaims };
}

/** Random tokens with GitHub's prefixes. */
export const randomToken = (prefix: string) =>
	`${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(27))).toString('base64url').slice(0, 36)}`;
