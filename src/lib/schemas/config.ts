/**
 * Process configuration from the environment (ADR 0005, ADR 0030).
 *
 * `loadConfig(env)` validates the raw variables with TypeBox and returns a
 * typed, normalised `Config`. It throws `ConfigError` listing every problem.
 * Dev mode is computed separately by `isDevMode`, because `dev` comes from
 * `$app/environment` (only available inside SvelteKit).
 */
import { Type, type Static } from '@sinclair/typebox';
import { issuesOf } from './standard';

const Url = Type.String({ pattern: '^https?://[^\\s]+$' });
const Port = Type.String({ pattern: '^[0-9]{1,5}$' });
const Flag = Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Literal('')]);
const NonEmpty = Type.String({ minLength: 1 });

/** Raw environment (strings), as read from `process.env` / `$env/dynamic/private`. */
export const RawEnv = Type.Object(
	{
		DATABASE_PATH: Type.Optional(NonEmpty),
		GITHUB_API_URL: Type.Optional(Url),
		GITHUB_WEB_URL: Type.Optional(Url),
		GITHUB_TOKEN: Type.Optional(NonEmpty),
		GITHUB_WEBHOOK_SECRET: Type.Optional(NonEmpty),
		GITHUB_OAUTH_CLIENT_ID: Type.Optional(NonEmpty),
		GITHUB_OAUTH_CLIENT_SECRET: Type.Optional(NonEmpty),
		ADMINS: Type.Optional(Type.String()),
		ORIGIN: Type.Optional(Url),
		PORT: Type.Optional(Port),
		OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String()),
		GRANARY_DEV: Type.Optional(Flag),
		GRANARY_STUB_BACKEND: Type.Optional(Flag),
		DAP_PORT: Type.Optional(Port),
		FAKE_GITHUB_PORT: Type.Optional(Port),
		FAKE_GITHUB_URL: Type.Optional(Url),
		FAKE_GITHUB_WEBHOOK_URL: Type.Optional(Url),
		/** Load generator base URL (ADR 0070). */
		LOADGEN_URL: Type.Optional(Url),
		NODE_ENV: Type.Optional(Type.String()),
		/** Comma-separated logins inserted into allowed_users at boot (added_by 'seed') if absent. ADR 0040. */
		ALLOWED_USERS_SEED: Type.Optional(Type.String()),
		/** First outbox retry delay in ms (doubles per attempt); default 1000. ADR 0041. */
		RELAY_BASE_DELAY_MS: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' }))
	},
	{ additionalProperties: true }
);
export type RawEnv = Static<typeof RawEnv>;

/** Variables that must be set unless `requireSecrets: false`. */
export const REQUIRED_SECRETS = [
	'GITHUB_TOKEN',
	'GITHUB_WEBHOOK_SECRET',
	'GITHUB_OAUTH_CLIENT_ID',
	'GITHUB_OAUTH_CLIENT_SECRET'
] as const;

export interface Config {
	databasePath: string;
	/** No trailing slash. */
	githubApiUrl: string;
	/** No trailing slash. */
	githubWebUrl: string;
	/** Empty string only when loaded with `requireSecrets: false`. */
	githubToken: string;
	webhookSecret: string;
	oauthClientId: string;
	oauthClientSecret: string;
	/** Lower-cased, trimmed, empties removed. */
	admins: string[];
	/** Public app URL, no trailing slash; null if unset (adapter derives it). */
	origin: string | null;
	port: number;
	/** `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`, or null when unset. */
	otlpTracesUrl: string | null;
	/** `GRANARY_DEV=1` */
	granaryDev: boolean;
	/** `GRANARY_STUB_BACKEND=1`: register `StubBackend` instead of the real one (UI work). */
	stubBackend: boolean;
	dapPort: number;
	/** Fake GitHub base URL: FAKE_GITHUB_URL, else `http://localhost:${FAKE_GITHUB_PORT}`. No trailing slash. */
	fakeGithubUrl: string;
	fakeGithubPort: number;
	fakeGithubWebhookUrl: string;
	/** Load generator base URL, no trailing slash (ADR 0070). */
	loadgenUrl: string;
	nodeEnv: string;
	/** `ALLOWED_USERS_SEED`, trimmed, empties removed (case kept). */
	allowedUsersSeed: string[];
	/** `RELAY_BASE_DELAY_MS`, default 1000. */
	relayBaseDelayMs: number;
}

export class ConfigError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
		this.name = 'ConfigError';
		this.problems = problems;
	}
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export interface LoadConfigOptions {
	/** Default true. Set false for the stub backend / tooling that never talks to GitHub. */
	requireSecrets?: boolean;
}

export function loadConfig(
	env: Record<string, string | undefined>,
	options: LoadConfigOptions = {}
): Config {
	const requireSecrets = options.requireSecrets ?? true;
	// Treat empty strings as unset (except flags) so `FOO=` behaves like no FOO.
	const cleaned: Record<string, string> = {};
	for (const key of Object.keys(RawEnv.properties)) {
		const v = env[key];
		if (v === undefined) continue;
		if (v === '' && key !== 'GRANARY_DEV' && key !== 'GRANARY_STUB_BACKEND' && key !== 'ADMINS') continue;
		cleaned[key] = v;
	}

	const problems = issuesOf(RawEnv, cleaned).map(
		(i) => `${i.path.join('.') || '(env)'}: ${i.message} (got ${JSON.stringify(cleaned[String(i.path[0])])})`
	);
	if (requireSecrets) {
		for (const key of REQUIRED_SECRETS) if (!cleaned[key]) problems.push(`${key}: required`);
	}
	if (problems.length) throw new ConfigError(problems);

	const raw = cleaned as RawEnv;
	const fakeGithubPort = Number(raw.FAKE_GITHUB_PORT ?? 4010);
	return {
		databasePath: raw.DATABASE_PATH ?? './data/granary.sqlite',
		githubApiUrl: trimSlash(raw.GITHUB_API_URL ?? 'https://api.github.com'),
		githubWebUrl: trimSlash(raw.GITHUB_WEB_URL ?? 'https://github.com'),
		githubToken: raw.GITHUB_TOKEN ?? '',
		webhookSecret: raw.GITHUB_WEBHOOK_SECRET ?? '',
		oauthClientId: raw.GITHUB_OAUTH_CLIENT_ID ?? '',
		oauthClientSecret: raw.GITHUB_OAUTH_CLIENT_SECRET ?? '',
		admins: (raw.ADMINS ?? '')
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
		origin: raw.ORIGIN ? trimSlash(raw.ORIGIN) : null,
		port: Number(raw.PORT ?? 3000),
		otlpTracesUrl: raw.OTEL_EXPORTER_OTLP_ENDPOINT
			? `${trimSlash(raw.OTEL_EXPORTER_OTLP_ENDPOINT)}/v1/traces`
			: null,
		granaryDev: raw.GRANARY_DEV === '1',
		stubBackend: raw.GRANARY_STUB_BACKEND === '1',
		dapPort: Number(raw.DAP_PORT ?? 4711),
		fakeGithubUrl: trimSlash(raw.FAKE_GITHUB_URL ?? `http://localhost:${fakeGithubPort}`),
		fakeGithubPort,
		fakeGithubWebhookUrl: raw.FAKE_GITHUB_WEBHOOK_URL ?? 'http://localhost:5173/webhook',
		loadgenUrl: trimSlash(raw.LOADGEN_URL ?? 'http://localhost:4040'),
		nodeEnv: raw.NODE_ENV ?? 'development',
		allowedUsersSeed: (raw.ALLOWED_USERS_SEED ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		relayBaseDelayMs: Number(raw.RELAY_BASE_DELAY_MS ?? 1000)
	};
}

/**
 * Dev mode (ADR 0005/0009): on iff (`dev` from `$app/environment` and
 * NODE_ENV is not `production`) or `GRANARY_DEV=1` explicitly.
 * `hooks.server.ts` stores the result in `event.locals.devMode`.
 */
export function isDevMode({ dev, env }: { dev: boolean; env: Record<string, string | undefined> }): boolean {
	if (env.GRANARY_DEV === '1') return true;
	return dev && env.NODE_ENV !== 'production';
}

/** Is `login` in the configured admins (case-insensitive)? */
export const isAdminLogin = (config: Pick<Config, 'admins'>, login: string): boolean =>
	config.admins.includes(login.toLowerCase());
