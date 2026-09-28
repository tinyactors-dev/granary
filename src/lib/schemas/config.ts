/**
 * Process configuration from the environment (ADR 0005, ADR 0030).
 *
 * `loadConfig(env)` validates the raw variables with TypeBox and returns a
 * typed, normalised `Config`. It throws `ConfigError` listing every problem.
 * Dev mode is computed separately by `isDevMode`, because `dev` comes from
 * `$app/environment` (only available inside SvelteKit).
 *
 * Only process-level settings are env/flags (ADR 0157): data dir, ORIGIN,
 * HOST, PORT, master key, NODE_ENV, GRANARY_DEV. Everything else is
 * in-product; `GRANARY_SEED_*` variables only seed it (ADR 0230).
 */
import { Type, type Static } from '@sinclair/typebox';
import { issuesOf } from './standard';
import { DATA_DIR_LAYOUT } from './cli';

const Url = Type.String({ pattern: '^https?://[^\\s]+$' });
const Port = Type.String({ pattern: '^[0-9]{1,5}$' });
const Flag = Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Literal('')]);
const NonEmpty = Type.String({ minLength: 1 });

/**
 * Raw environment (strings), as read from `process.env` / `$env/dynamic/private`.
 * Names follow ADR 0230: standard process variables unprefixed, everything
 * granary-specific `GRANARY_*`, seeds `GRANARY_SEED_*`, dev-only knobs
 * `GRANARY_DEV_*`, test-only knobs `GRANARY_TEST_*`, the fakes' URLs by the
 * fakes' own prefixes.
 */
export const RawEnv = Type.Object(
	{
		/** Data directory (ADR 0157); `granary serve --data` sets it. */
		GRANARY_DATA_DIR: Type.Optional(NonEmpty),
		XDG_STATE_HOME: Type.Optional(Type.String()),
		HOME: Type.Optional(Type.String()),
		HOST: Type.Optional(NonEmpty),
		ORIGIN: Type.Optional(Url),
		PORT: Type.Optional(Port),
		NODE_ENV: Type.Optional(Type.String()),
		/** GitHub's REST and web base URLs; point them at the fake GitHub in dev/tests (or at GitHub Enterprise). */
		GRANARY_GITHUB_API_URL: Type.Optional(Url),
		GRANARY_GITHUB_WEB_URL: Type.Optional(Url),
		/** Seeds (ADR 0161, 0040): logins added once, never overwriting in-product changes. */
		GRANARY_SEED_ADMINS: Type.Optional(Type.String()),
		GRANARY_SEED_ALLOWLIST: Type.Optional(Type.String()),
		/** `1` enables /__dev and the DAP server outside `vite dev` (ADR 0009). */
		GRANARY_DEV: Type.Optional(Flag),
		GRANARY_DAP_PORT: Type.Optional(Port),
		/** Dev only: `origin=user:pass,…` login hints in the /__dev Tools card (ADR 0027). */
		GRANARY_DEV_LOGIN_HINTS: Type.Optional(Type.String()),
		/** Dev/tests only: connect to the fake GitHub as a GitHub App automatically (ADR 0230). */
		GRANARY_DEV_GITHUB_AUTOCONNECT: Type.Optional(Flag),
		/** UI work without the actor system (ADR 0032). */
		GRANARY_STUB_BACKEND: Type.Optional(Flag),
		/** Test only: first outbox retry delay in ms (doubles per attempt); default 1000 (ADR 0041). */
		GRANARY_TEST_RELAY_BASE_DELAY_MS: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
		/** Dev tools (the /__dev console links and proxies them). */
		FAKE_GITHUB_URL: Type.Optional(Url),
		FAKE_INFRA_URL: Type.Optional(Url),
		LOADGEN_URL: Type.Optional(Url)
	},
	{ additionalProperties: true }
);
export type RawEnv = Static<typeof RawEnv>;

/**
 * Data directory (ADR 0157): `flag` (`--data`) > `GRANARY_DATA_DIR` >
 * `$XDG_STATE_HOME/granary` > `~/.local/state/granary`. Returned as given
 * (relative paths stay relative).
 */
export function resolveDataDir(env: Record<string, string | undefined>, flag?: string | null): string {
	if (flag) return trimSlash(flag) || '/';
	if (env.GRANARY_DATA_DIR) return trimSlash(env.GRANARY_DATA_DIR) || '/';
	if (env.XDG_STATE_HOME) return `${trimSlash(env.XDG_STATE_HOME)}/granary`;
	return `${trimSlash(env.HOME ?? '.')}/.local/state/granary`;
}

export interface Config {
	/** Data directory (ADR 0157): databases, master.key, granary.env, admin.sock. */
	dataDir: string;
	/** `<dataDir>/granary.sqlite`. */
	databasePath: string;
	/** Bind address (`HOST`, default 0.0.0.0; used by `granary serve`). */
	host: string;
	/** No trailing slash. */
	githubApiUrl: string;
	/** No trailing slash. */
	githubWebUrl: string;
	/** `GRANARY_SEED_ADMINS`: lower-cased. Admins themselves live in the `admins` table (ADR 0161). */
	seedAdmins: string[];
	/** `GRANARY_SEED_ALLOWLIST` (case kept). */
	seedAllowlist: string[];
	/** Public app URL, no trailing slash; null if unset (adapter derives it). */
	origin: string | null;
	port: number;
	/** `GRANARY_DEV=1` */
	granaryDev: boolean;
	/** `GRANARY_STUB_BACKEND=1`: register `StubBackend` instead of the real one (UI work). */
	stubBackend: boolean;
	dapPort: number;
	/** Dev-only login hints for local stand-in UIs, keyed by URL origin. */
	devLoginHints: Record<string, { username: string; password: string }>;
	/** `GRANARY_DEV_GITHUB_AUTOCONNECT=1` (ADR 0230). */
	devGithubAutoconnect: boolean;
	/** Fake GitHub base URL (dev tools), no trailing slash. */
	fakeGithubUrl: string;
	/** Load generator base URL, no trailing slash (ADR 0070). */
	loadgenUrl: string;
	/** fake-infra base URL (ADR 0130), no trailing slash. */
	fakeInfraUrl: string;
	nodeEnv: string;
	/** `GRANARY_TEST_RELAY_BASE_DELAY_MS`, default 1000. */
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
const list = (raw: string | undefined) =>
	(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

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

const FLAGS = new Set(['GRANARY_DEV', 'GRANARY_STUB_BACKEND', 'GRANARY_DEV_GITHUB_AUTOCONNECT', 'GRANARY_SEED_ADMINS', 'GRANARY_SEED_ALLOWLIST']);

export function loadConfig(env: Record<string, string | undefined>): Config {
	// Treat empty strings as unset (except flags/lists) so `FOO=` behaves like no FOO.
	const cleaned: Record<string, string> = {};
	for (const key of Object.keys(RawEnv.properties)) {
		const v = env[key];
		if (v === undefined) continue;
		if (v === '' && !FLAGS.has(key)) continue;
		cleaned[key] = v;
	}

	const problems = issuesOf(RawEnv, cleaned).map(
		(i) => `${i.path.join('.') || '(env)'}: ${i.message} (got ${JSON.stringify(cleaned[String(i.path[0])])})`
	);
	if (problems.length) throw new ConfigError(problems);

	const raw = cleaned as RawEnv;
	const dataDir = resolveDataDir(cleaned);
	return {
		dataDir,
		databasePath: `${dataDir}/${DATA_DIR_LAYOUT.database}`,
		host: raw.HOST ?? '0.0.0.0',
		githubApiUrl: trimSlash(raw.GRANARY_GITHUB_API_URL ?? 'https://api.github.com'),
		githubWebUrl: trimSlash(raw.GRANARY_GITHUB_WEB_URL ?? 'https://github.com'),
		seedAdmins: list(raw.GRANARY_SEED_ADMINS).map((s) => s.toLowerCase()),
		seedAllowlist: list(raw.GRANARY_SEED_ALLOWLIST),
		origin: raw.ORIGIN ? trimSlash(raw.ORIGIN) : null,
		port: Number(raw.PORT ?? 3000),
		granaryDev: raw.GRANARY_DEV === '1',
		stubBackend: raw.GRANARY_STUB_BACKEND === '1',
		dapPort: Number(raw.GRANARY_DAP_PORT ?? 4711),
		devLoginHints: parseLoginHints(raw.GRANARY_DEV_LOGIN_HINTS),
		devGithubAutoconnect: raw.GRANARY_DEV_GITHUB_AUTOCONNECT === '1',
		fakeGithubUrl: trimSlash(raw.FAKE_GITHUB_URL ?? 'http://localhost:4010'),
		loadgenUrl: trimSlash(raw.LOADGEN_URL ?? 'http://localhost:4040'),
		fakeInfraUrl: trimSlash(raw.FAKE_INFRA_URL ?? 'http://localhost:4090'),
		nodeEnv: raw.NODE_ENV ?? 'development',
		relayBaseDelayMs: Number(raw.GRANARY_TEST_RELAY_BASE_DELAY_MS ?? 1000)
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

