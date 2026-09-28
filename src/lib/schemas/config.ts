/**
 * Process configuration from the environment (ADR 0005, ADR 0030).
 *
 * `loadConfig(env)` validates the raw variables with TypeBox and returns a
 * typed, normalised `Config`. It throws `ConfigError` listing every problem.
 * Dev mode is computed separately by `isDevMode`, because `dev` comes from
 * `$app/environment` (only available inside SvelteKit).
 *
 * Only process-level settings are env/flags (ADR 0157): data dir, ORIGIN,
 * HOST, PORT, proxy headers, master key, NODE_ENV, GRANARY_DEV. Everything
 * else is in-product; the GitHub/admin variables here are optional seeds.
 */
import { Type, type Static } from '@sinclair/typebox';
import { issuesOf } from './standard';
import { DATA_DIR_LAYOUT } from './cli';

const Url = Type.String({ pattern: '^https?://[^\\s]+$' });
const Port = Type.String({ pattern: '^[0-9]{1,5}$' });
const Flag = Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Literal('')]);
const NonEmpty = Type.String({ minLength: 1 });

/** Raw environment (strings), as read from `process.env` / `$env/dynamic/private`. */
export const RawEnv = Type.Object(
	{
		/** Data directory (ADR 0157); `granary serve --data` sets it. */
		GRANARY_DATA_DIR: Type.Optional(NonEmpty),
		/** Dev/tests: explicit granary.sqlite path; the data dir defaults to its directory. */
		DATABASE_PATH: Type.Optional(NonEmpty),
		XDG_STATE_HOME: Type.Optional(Type.String()),
		HOME: Type.Optional(Type.String()),
		HOST: Type.Optional(NonEmpty),
		/** Admin seeds (ADR 0161); alias ADMINS. */
		GRANARY_ADMINS: Type.Optional(Type.String()),
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
		/** fake-infra base URL (ADR 0130): fake R2, OTLP receiver, exe.dev proxy. Dev only. */
		FAKE_INFRA_URL: Type.Optional(Url),
		/** Dev only: `origin=user:pass,…` login hints shown in the /__dev Tools card (ADR 0027). */
		DEV_LOGIN_HINTS: Type.Optional(Type.String()),
		NODE_ENV: Type.Optional(Type.String()),
		/** Comma-separated logins inserted into allowed_users at boot (added_by 'seed') if absent. ADR 0040. */
		ALLOWED_USERS_SEED: Type.Optional(Type.String()),
		/** First outbox retry delay in ms (doubles per attempt); default 1000. ADR 0041. */
		RELAY_BASE_DELAY_MS: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' }))
	},
	{ additionalProperties: true }
);
export type RawEnv = Static<typeof RawEnv>;

/**
 * Formerly required GitHub variables. Since ADR 0157 nothing is required at
 * boot: these are optional seeds for the in-product GitHub connection.
 */
export const REQUIRED_SECRETS = [] as const;

/**
 * Data directory (ADR 0157): `flag` (`--data`) > `GRANARY_DATA_DIR` >
 * directory of `DATABASE_PATH` (dev/tests) > `$XDG_STATE_HOME/granary` >
 * `~/.local/state/granary`. Returned as given (relative paths stay relative).
 */
export function resolveDataDir(env: Record<string, string | undefined>, flag?: string | null): string {
	if (flag) return trimSlash(flag) || '/';
	if (env.GRANARY_DATA_DIR) return trimSlash(env.GRANARY_DATA_DIR) || '/';
	if (env.DATABASE_PATH && env.DATABASE_PATH !== ':memory:') {
		const i = env.DATABASE_PATH.lastIndexOf('/');
		return i > 0 ? env.DATABASE_PATH.slice(0, i) : i === 0 ? '/' : '.';
	}
	if (env.XDG_STATE_HOME) return `${trimSlash(env.XDG_STATE_HOME)}/granary`;
	return `${trimSlash(env.HOME ?? '.')}/.local/state/granary`;
}

export interface Config {
	/** Data directory (ADR 0157): databases, master.key, granary.env, admin.sock. */
	dataDir: string;
	/** `DATABASE_PATH`, else `<dataDir>/granary.sqlite`. */
	databasePath: string;
	/** Bind address (`HOST`, default 0.0.0.0; used by `granary serve`). */
	host: string;
	/** No trailing slash. */
	githubApiUrl: string;
	/** No trailing slash. */
	githubWebUrl: string;
	/** Empty string only when loaded with `requireSecrets: false`. */
	githubToken: string;
	webhookSecret: string;
	oauthClientId: string;
	oauthClientSecret: string;
	/**
	 * Admin seeds from `GRANARY_ADMINS` (alias `ADMINS`): lower-cased, trimmed,
	 * empties removed. Admins themselves live in the `admins` table (ADR 0161).
	 */
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
	/** fake-infra base URL (ADR 0130), no trailing slash. */
	fakeInfraUrl: string;
	/** Dev-only login hints for local stand-in UIs, keyed by URL origin. */
	devLoginHints: Record<string, { username: string; password: string }>;
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
	/** Ignored since ADR 0157 (nothing is required at boot); kept for callers. */
	requireSecrets?: boolean;
}

/** `http://localhost:9001=user:pass,http://localhost:3300=admin:admin` → by origin. */
function parseLoginHints(raw: string | undefined): Record<string, { username: string; password: string }> {
	const out: Record<string, { username: string; password: string }> = {};
	for (const part of (raw ?? '').split(',')) {
		const m = /^\s*(https?:\/\/[^=\s]+)=([^:]+):(.*)$/.exec(part);
		if (!m) continue;
		try {
			out[new URL(m[1]!).origin] = { username: m[2]!.trim(), password: m[3]!.trim() };
		} catch {
			/* ignore malformed entries */
		}
	}
	return out;
}

export function loadConfig(
	env: Record<string, string | undefined>,
	options: LoadConfigOptions = {}
): Config {
	void options;
	// Treat empty strings as unset (except flags) so `FOO=` behaves like no FOO.
	const cleaned: Record<string, string> = {};
	for (const key of Object.keys(RawEnv.properties)) {
		const v = env[key];
		if (v === undefined) continue;
		if (v === '' && key !== 'GRANARY_DEV' && key !== 'GRANARY_STUB_BACKEND' && key !== 'ADMINS' && key !== 'GRANARY_ADMINS') continue;
		cleaned[key] = v;
	}

	const problems = issuesOf(RawEnv, cleaned).map(
		(i) => `${i.path.join('.') || '(env)'}: ${i.message} (got ${JSON.stringify(cleaned[String(i.path[0])])})`
	);
	if (problems.length) throw new ConfigError(problems);

	const raw = cleaned as RawEnv;
	const fakeGithubPort = Number(raw.FAKE_GITHUB_PORT ?? 4010);
	const dataDir = resolveDataDir(cleaned);
	return {
		dataDir,
		databasePath: raw.DATABASE_PATH ?? `${dataDir}/${DATA_DIR_LAYOUT.database}`,
		host: raw.HOST ?? '0.0.0.0',
		githubApiUrl: trimSlash(raw.GITHUB_API_URL ?? 'https://api.github.com'),
		githubWebUrl: trimSlash(raw.GITHUB_WEB_URL ?? 'https://github.com'),
		githubToken: raw.GITHUB_TOKEN ?? '',
		webhookSecret: raw.GITHUB_WEBHOOK_SECRET ?? '',
		oauthClientId: raw.GITHUB_OAUTH_CLIENT_ID ?? '',
		oauthClientSecret: raw.GITHUB_OAUTH_CLIENT_SECRET ?? '',
		admins: (raw.GRANARY_ADMINS ?? raw.ADMINS ?? '')
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
		fakeInfraUrl: trimSlash(raw.FAKE_INFRA_URL ?? 'http://localhost:4090'),
		devLoginHints: parseLoginHints(raw.DEV_LOGIN_HINTS),
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
