/**
 * GitHub OAuth web flow helpers (ADR 0034, ADR 0160): the state cookie, the
 * client credentials (the GitHub App's own OAuth client in app mode, the
 * separate OAuth app in token mode) and the two calls `/auth/callback` makes.
 */
import { timingSafeEqual } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import {
	isOAuthAccessTokenError,
	parseAuthenticatedUser,
	parseOAuthAccessTokenResponse,
	type AuthenticatedUser,
	type OAuthAccessTokenRequest
} from '$lib/schemas/github';
import { check } from '$lib/schemas/standard';
import type { Config } from '$lib/schemas/config';
import { getRuntime } from './system';

export interface OAuthCredentials {
	clientId: string;
	clientSecret: string;
}

/**
 * The OAuth client for UI sign-in, from the GitHub connection; null while
 * GitHub is not connected (sign in with `granary login-link` then). Without a
 * booted runtime (stub backend) the legacy config values are used.
 */
export async function oauthCredentials(config: Config): Promise<OAuthCredentials | null> {
	const rt = getRuntime();
	if (rt && !rt.closed) return rt.github.oauthCredentials();
	return config.oauthClientId && config.oauthClientSecret ? { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret } : null;
}

const OAuthStateCookie = Type.Object(
	{ state: Type.String({ minLength: 1 }), redirect: Type.String() },
	{ additionalProperties: false }
);
export interface OAuthState {
	state: string;
	redirect: string;
}

export const encodeOAuthState = (s: OAuthState): string => Buffer.from(JSON.stringify(s)).toString('base64url');

export function decodeOAuthState(value: string | undefined): OAuthState | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		return check(OAuthStateCookie, parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function sameState(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export class OAuthFailure extends Error {
	constructor(
		readonly status: 401 | 502,
		message: string
	) {
		super(message);
		this.name = 'OAuthFailure';
	}
}

/** `POST {GITHUB_WEB_URL}/login/oauth/access_token` → access token. */
export async function exchangeCode(config: Config, creds: OAuthCredentials, code: string, redirectUri: string): Promise<string> {
	const body: OAuthAccessTokenRequest = {
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		code,
		redirect_uri: redirectUri
	};
	let res: Response;
	try {
		res = await fetch(`${config.githubWebUrl}/login/oauth/access_token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000)
		});
	} catch (e) {
		throw new OAuthFailure(502, `GitHub unreachable: ${(e as Error).message}`);
	}
	if (!res.ok) throw new OAuthFailure(502, `GitHub token exchange failed (HTTP ${res.status})`);
	let parsed;
	try {
		parsed = parseOAuthAccessTokenResponse(await res.json());
	} catch (e) {
		throw new OAuthFailure(502, `Unexpected token response: ${(e as Error).message}`);
	}
	if (isOAuthAccessTokenError(parsed)) {
		throw new OAuthFailure(401, `GitHub refused the sign-in: ${parsed.error_description ?? parsed.error}`);
	}
	return parsed.access_token;
}

/** `GET {GITHUB_API_URL}/user` with the user's token. */
export async function fetchUser(config: Config, token: string): Promise<AuthenticatedUser> {
	let res: Response;
	try {
		res = await fetch(`${config.githubApiUrl}/user`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'User-Agent': 'granary'
			},
			signal: AbortSignal.timeout(10_000)
		});
	} catch (e) {
		throw new OAuthFailure(502, `GitHub unreachable: ${(e as Error).message}`);
	}
	if (res.status === 401) throw new OAuthFailure(401, 'GitHub rejected the access token');
	if (!res.ok) throw new OAuthFailure(502, `GitHub /user failed (HTTP ${res.status})`);
	try {
		return parseAuthenticatedUser(await res.json());
	} catch (e) {
		throw new OAuthFailure(502, `Unexpected /user response: ${(e as Error).message}`);
	}
}
