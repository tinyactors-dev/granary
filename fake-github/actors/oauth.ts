/**
 * `oauth/main` — the fake OAuth web flow (ADR 0006, ADR 0060): single-use
 * authorization codes (10 min) and the access tokens they are exchanged for.
 */
import { handlerChart } from '../../src/lib/charts';

export const OAUTH_ADDRESS = 'oauth/main';
export const OAUTH_CHART = 'oauth';

export interface OAuthCode {
	login: string;
	clientId: string;
	redirectUri: string | null;
	expiresAt: number;
}

export interface OAuthData {
	codes: Record<string, OAuthCode>;
	/** access token → login */
	tokens: Record<string, string>;
}

export const OAUTH_EVENTS = { authorize: 'oauth.authorize', exchange: 'oauth.exchange', whoami: 'oauth.whoami' } as const;

export interface AuthorizeEvent {
	code: string;
	login: string;
	clientId: string;
	redirectUri: string | null;
	now: number;
}
export interface ExchangeEvent {
	code: string;
	clientId: string;
	token: string;
	now: number;
}

export const oauthChart = handlerChart<OAuthData>({
	name: OAUTH_CHART,
	initial: { codes: {}, tokens: {} },
	handlers: {
		[OAUTH_EVENTS.authorize]: (d, e: AuthorizeEvent) => {
			d.codes[e.code] = { login: e.login, clientId: e.clientId, redirectUri: e.redirectUri, expiresAt: e.now + 10 * 60_000 };
			return { code: e.code };
		},
		[OAUTH_EVENTS.exchange]: (d, e: ExchangeEvent) => {
			const c = d.codes[e.code];
			delete d.codes[e.code];
			if (!c || c.expiresAt < e.now || c.clientId !== e.clientId) {
				return {
					error: 'bad_verification_code',
					error_description: 'The code passed is incorrect or expired.',
					error_uri: 'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code'
				};
			}
			d.tokens[e.token] = c.login;
			return { access_token: e.token, token_type: 'bearer', scope: '' };
		},
		[OAUTH_EVENTS.whoami]: (d, e: { token: string }) => d.tokens[e.token] ?? null
	}
});
