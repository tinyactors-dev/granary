/**
 * Integration test harness (ADR 0007, ADR 0061).
 *
 * Starts, per test file:
 *  1. an in-process OTLP/HTTP collector (`otlp.ts`),
 *  2. the fake GitHub (`bun fake-github/server.ts`) as a subprocess,
 *  3. the BUILT app (`bun build/index.js`, from `mise run build`) as a
 *     subprocess with a temp GRANARY_DATA_DIR,
 * on free ports, and waits for both to answer HTTP. By default the app
 * connects to the fake GitHub as a GitHub App by itself
 * (`GRANARY_DEV_GITHUB_AUTOCONNECT`, ADR 0230) and the harness waits for
 * that; `github: 'manual'` leaves it unconnected (setup tests).
 *
 * ```ts
 * const h = useHarness();                     // beforeAll/afterAll
 * test('…', async () => {
 *   const { number } = await h().fakeGithub.createIssue({...});
 *   await h().waitForSpan(actorFinished(issueAddress(repoId, number), 'closed'));
 * });
 * ```
 */
import { afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { Collector, type CollectedSpan } from './otlp';
import { FakeGithubClient } from './fake-github-client';
import { APP_SERVICE, TraceIndex, type SpanPredicate } from './traces';

export const ROOT = resolve(import.meta.dir, '..');

export interface HarnessOptions {
	/**
	 * `auto` (default): the app connects to the fake GitHub as a GitHub App at
	 * boot and the fake installs it on every account with repo activity.
	 * `manual`: GitHub stays unconnected until the test sets it up in-product.
	 */
	github?: 'auto' | 'manual';
	/** Extra env for the app process. */
	appEnv?: Record<string, string>;
	/** Extra env for the fake GitHub process. */
	fakeEnv?: Record<string, string>;
	/** Readiness timeout per process (ms). Default 30 000. */
	bootTimeout?: number;
	/** Also start the load generator (`bun loadgen/server.ts`, ADR 0070). */
	loadgen?: boolean;
	/** Extra env for the load generator process. */
	loadgenEnv?: Record<string, string>;
	/**
	 * Also start fake-infra (`bun fake-infra/server.ts`, ADR 0130) and wire the
	 * app's operations module to it (ADR 0150): R2 seed destination on the fake
	 * R2, dev mode for the `/__dev/api/ops` surface, fast test timings.
	 * `opsSink` picks where the seeded OTLP sink goes: the harness collector
	 * (default; granary + granary-ops traces arrive there) or fake-infra's
	 * exe.dev token front (telemetry scenarios).
	 */
	infra?: boolean;
	/** Runs after the collector/fakes start and before the app starts (e.g. pre-fill the DB). */
	prepare?: (h: Harness) => void | Promise<void>;
	opsSink?: 'collector' | 'exe-token';
	/** Extra env for the fake-infra process. */
	infraEnv?: Record<string, string>;
}

/** Test values for the ops module and fake-infra (FAKE; ADR 0150). */
export const OPS_TEST = {
	masterKey: 'a0'.repeat(32),
	accountId: '0'.repeat(32),
	bucket: 'granary-backups',
	accessKeyId: '0000000000000000000000000000tst1',
	secretAccessKey: 'ops-test-secret-access-key-0000000000000000000000000000tst1',
	exeToken: 'exe_ops_test_token_0123456789'
} as const;

export interface WaitOptions {
	timeout?: number;
	interval?: number;
	/** Shown in the timeout error. */
	message?: string;
}

/** Captured stdout/stderr of a subprocess (last `max` lines). */
class Output {
	readonly lines: string[] = [];
	constructor(
		readonly label: string,
		readonly max = 400
	) {}
	push(chunk: string) {
		for (const line of chunk.split('\n')) {
			if (!line) continue;
			this.lines.push(`[${this.label}] ${line}`);
			if (this.lines.length > this.max) this.lines.shift();
		}
		if (process.env.GRANARY_TEST_VERBOSE === '1') process.stderr.write(chunk.replace(/^/gm, `[${this.label}] `));
	}
	tail(n = 60) {
		return this.lines.slice(-n).join('\n');
	}
}

async function pump(stream: ReadableStream<Uint8Array> | null | undefined, out: Output) {
	if (!stream) return;
	const decoder = new TextDecoder();
	try {
		for await (const chunk of stream) out.push(decoder.decode(chunk, { stream: true }));
	} catch {
		/* process died */
	}
}

/** A free TCP port on 127.0.0.1 (bind port 0, read, release). */
export function freePort(): number {
	const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
	const port = s.port!;
	s.stop(true);
	return port;
}

async function waitHttp(url: string, proc: Subprocess, out: Output, timeout: number, ok: (res: Response, body: string) => boolean) {
	const deadline = Date.now() + timeout;
	let last = '';
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.signalCode !== null) {
			throw new Error(`${out.label} exited (${proc.exitCode ?? proc.signalCode}) before it was ready\n${out.tail()}`);
		}
		try {
			const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
			const body = await res.text().catch(() => '');
			if (ok(res, body)) return;
			last = `HTTP ${res.status}`;
		} catch (e) {
			last = (e as Error).message;
		}
		await Bun.sleep(100);
	}
	throw new Error(`${out.label} not ready at ${url} after ${timeout} ms (last: ${last})\n${out.tail()}`);
}

export class Harness {
	readonly collector = new Collector();
	readonly fakeGithub: FakeGithubClient;
	readonly fakeUrl: string;
	readonly appUrl: string;
	readonly fakePort = freePort();
	readonly appPort = freePort();
	readonly tmpDir = mkdtempSync(join(tmpdir(), 'granary-test-'));
	readonly databasePath = join(this.tmpDir, 'granary.sqlite');
	/** ADR 0203: extra app env set at runtime (e.g. by `prepare` after `granary init`). */
	readonly extraAppEnv: Record<string, string> = {};
	readonly appOutput = new Output('app');
	readonly fakeOutput = new Output('fake-github');
	readonly loadgenPort = freePort();
	readonly loadgenUrl: string;
	readonly loadgenOutput = new Output('loadgen');
	readonly infraPort = freePort();
	readonly infraTokenPort = freePort();
	readonly infraPeerPort = freePort();
	readonly infraUrl: string;
	readonly infraOutput = new Output('fake-infra');
	readonly dapPort = freePort();
	private infra: Subprocess | null = null;
	private loadgen: Subprocess | null = null;
	private app: Subprocess | null = null;
	private fake: Subprocess | null = null;
	private appOutputs: Output[] = [];

	constructor(readonly options: HarnessOptions = {}) {
		this.fakeUrl = `http://127.0.0.1:${this.fakePort}`;
		this.appUrl = `http://127.0.0.1:${this.appPort}`;
		this.loadgenUrl = `http://127.0.0.1:${this.loadgenPort}`;
		this.infraUrl = `http://127.0.0.1:${this.infraPort}`;
		this.fakeGithub = new FakeGithubClient(this.fakeUrl);
	}

	get bootTimeout() {
		return this.options.bootTimeout ?? 30_000;
	}

	/** Base env: inherited PATH/HOME etc., minus anything that would change modes. */
	private baseEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined) continue;
			if (/^(GRANARY_|FAKE_GITHUB_|FAKE_INFRA_|LOADGEN_|ORIGIN$|PORT$|HOST$)/.test(k)) continue;
			env[k] = v;
		}
		return env;
	}

	appEnv(): Record<string, string> {
		return {
			...this.baseEnv(),
			NODE_ENV: 'production',
			PORT: String(this.appPort),
			HOST: '127.0.0.1',
			ORIGIN: this.appUrl,
			// ADR 0157: the data dir holds granary.sqlite, ops.sqlite, admin.sock.
			GRANARY_DATA_DIR: this.tmpDir,
			GRANARY_MASTER_KEY: OPS_TEST.masterKey,
			GRANARY_GITHUB_API_URL: this.fakeUrl,
			GRANARY_GITHUB_WEB_URL: this.fakeUrl,
			...(this.githubMode === 'auto' ? { GRANARY_DEV_GITHUB_AUTOCONNECT: '1' } : {}),
			FAKE_GITHUB_URL: this.fakeUrl,
			GRANARY_SEED_ADMINS: 'admin',
			GRANARY_SEED_ALLOWLIST: 'alice',
			GRANARY_SEED_OTLP_ENDPOINT: this.collector.url,
			GRANARY_SEED_OTLP_AUTH: 'none',
			...(this.options.infra ? this.opsEnv() : {}),
			...this.options.appEnv,
			...this.extraAppEnv
		};
	}

	/** App env for the operations module against fake-infra (ADR 0150). */
	opsEnv(): Record<string, string> {
		const sink: Record<string, string> =
			this.options.opsSink === 'exe-token'
				? { GRANARY_SEED_OTLP_ENDPOINT: `http://127.0.0.1:${this.infraTokenPort}`, GRANARY_SEED_OTLP_AUTH: 'exe-vm-token', GRANARY_SEED_OTLP_TOKEN: OPS_TEST.exeToken }
				: { GRANARY_SEED_OTLP_ENDPOINT: this.collector.url, GRANARY_SEED_OTLP_AUTH: 'none' };
		return {
			GRANARY_DEV: '1',
			GRANARY_DAP_PORT: String(this.dapPort),
			GRANARY_SEED_R2_ACCOUNT_ID: OPS_TEST.accountId,
			GRANARY_SEED_R2_JURISDICTION: 'eu',
			GRANARY_SEED_R2_BUCKET: OPS_TEST.bucket,
			GRANARY_SEED_R2_ACCESS_KEY_ID: OPS_TEST.accessKeyId,
			GRANARY_SEED_R2_SECRET_ACCESS_KEY: OPS_TEST.secretAccessKey,
			GRANARY_SEED_R2_ENDPOINT_OVERRIDE: `${this.infraUrl}/s3/eu`,
			GRANARY_TEST_WATCHDOG_INTERVAL_MS: '300',
			GRANARY_TEST_GRACE_SCALE: '0.0001',
			GRANARY_TEST_RETRY_BASE_MS: '150',
			GRANARY_TEST_RETENTION_INTERVAL_MS: '2000',
			...sink
		};
	}

	infraEnv(): Record<string, string> {
		return {
			...this.baseEnv(),
			FAKE_INFRA_PORT: String(this.infraPort),
			FAKE_INFRA_EXE_TOKEN_PORT: String(this.infraTokenPort),
			FAKE_INFRA_EXE_PEER_PORT: String(this.infraPeerPort),
			FAKE_INFRA_SEED_BUCKET: OPS_TEST.bucket,
			FAKE_INFRA_SEED_JURISDICTION: 'eu',
			FAKE_INFRA_SEED_ACCESS_KEY_ID: OPS_TEST.accessKeyId,
			FAKE_INFRA_SEED_SECRET_ACCESS_KEY: OPS_TEST.secretAccessKey,
			FAKE_INFRA_SEED_EXE_TOKEN: OPS_TEST.exeToken,
			...this.options.infraEnv
		};
	}

	private async startInfra() {
		this.infra = Bun.spawn(['bun', 'fake-infra/server.ts'], { cwd: ROOT, env: this.infraEnv(), stdout: 'pipe', stderr: 'pipe' });
		void pump(this.infra.stdout as ReadableStream<Uint8Array>, this.infraOutput);
		void pump(this.infra.stderr as ReadableStream<Uint8Array>, this.infraOutput);
		await waitHttp(`${this.infraUrl}/healthz`, this.infra, this.infraOutput, this.bootTimeout, (r) => r.ok);
	}

	fakeEnv(): Record<string, string> {
		return {
			...this.baseEnv(),
			FAKE_GITHUB_PORT: String(this.fakePort),
			FAKE_GITHUB_URL: this.fakeUrl,
			FAKE_GITHUB_OTLP_ENDPOINT: this.collector.url,
			...this.options.fakeEnv
		};
	}

	async start(): Promise<this> {
		if (!existsSync(join(ROOT, 'build', 'index.js'))) {
			throw new Error('build/index.js missing — run `mise run build` (or `mise run test`, which builds first)');
		}
		this.collector.start();
		if (this.options.infra) await this.startInfra();
		await this.startFake();
		await this.options.prepare?.(this);
		await this.startApp();
		if (this.options.loadgen) await this.startLoadgen();
		return this;
	}

	loadgenEnv(): Record<string, string> {
		return {
			...this.baseEnv(),
			LOADGEN_PORT: String(this.loadgenPort),
			FAKE_GITHUB_URL: this.fakeUrl,
			LOADGEN_ALLOWLISTED: 'alice',
			LOADGEN_OTLP_ENDPOINT: this.collector.url,
			...this.options.loadgenEnv
		};
	}

	private async startLoadgen() {
		this.loadgen = Bun.spawn(['bun', 'loadgen/server.ts'], {
			cwd: ROOT,
			env: this.loadgenEnv(),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		void pump(this.loadgen.stdout as ReadableStream<Uint8Array>, this.loadgenOutput);
		void pump(this.loadgen.stderr as ReadableStream<Uint8Array>, this.loadgenOutput);
		await waitHttp(`${this.loadgenUrl}/healthz`, this.loadgen, this.loadgenOutput, this.bootTimeout, (r) => r.ok);
	}

	private async startFake() {
		this.fake = Bun.spawn(['bun', 'fake-github/server.ts'], {
			cwd: ROOT,
			env: this.fakeEnv(),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		void pump(this.fake.stdout as ReadableStream<Uint8Array>, this.fakeOutput);
		void pump(this.fake.stderr as ReadableStream<Uint8Array>, this.fakeOutput);
		await waitHttp(`${this.fakeUrl}/healthz`, this.fake, this.fakeOutput, this.bootTimeout, (r) => r.ok);
	}

	private async startApp() {
		const out = this.appOutput;
		out.push(`--- starting app (epoch ${this.collector.epochOf(APP_SERVICE)}) ---\n`);
		this.app = Bun.spawn(['bun', 'build/index.js'], {
			cwd: ROOT,
			env: this.appEnv(),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		void pump(this.app.stdout as ReadableStream<Uint8Array>, out);
		void pump(this.app.stderr as ReadableStream<Uint8Array>, out);
		// /readyz answers 200 once the database, actor system and backend are up (ADR 0163);
		// with `github: 'auto'` also wait until the GitHub App connection is made.
		await waitHttp(`${this.appUrl}/readyz`, this.app, out, this.bootTimeout, (r, text) => {
			if (!r.ok) return false;
			if (this.githubMode !== 'auto') return true;
			try {
				return (JSON.parse(text) as { checks?: { github?: string } }).checks?.github === 'ready';
			} catch {
				return false;
			}
		});
	}

	get githubMode(): 'auto' | 'manual' {
		return this.options.github ?? 'auto';
	}

	/** Kill the app (default SIGKILL) and start it again on the same port and DB. */
	async restartApp({ kill = 'SIGKILL' as NodeJS.Signals | number } = {}) {
		await this.killApp(kill);
		this.collector.bumpEpoch(APP_SERVICE);
		await this.startApp();
	}

	async killApp(signal: NodeJS.Signals | number = 'SIGKILL') {
		if (!this.app) return;
		this.app.kill(signal);
		await this.app.exited;
		this.app = null;
	}

	async stop() {
		if (this.loadgen) {
			this.loadgen.kill('SIGTERM');
			await Promise.race([this.loadgen.exited, Bun.sleep(2000)]);
			if (this.loadgen.exitCode === null) this.loadgen.kill('SIGKILL');
			this.loadgen = null;
		}
		await this.killApp('SIGTERM').catch(() => undefined);
		if (this.fake) {
			this.fake.kill('SIGTERM');
			await Promise.race([this.fake.exited, Bun.sleep(2000)]);
			if (this.fake.exitCode === null) this.fake.kill('SIGKILL');
			this.fake = null;
		}
		if (this.infra) {
			this.infra.kill('SIGTERM');
			await Promise.race([this.infra.exited, Bun.sleep(2000)]);
			if (this.infra.exitCode === null) this.infra.kill('SIGKILL');
			this.infra = null;
		}
		this.collector.stop();
		rmSync(this.tmpDir, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	// Traces
	// -------------------------------------------------------------------------

	/** All spans collected so far (all services). */
	spans(): CollectedSpan[] {
		return [...this.collector.spans];
	}

	/** Spans grouped into actor sessions with resolved addresses. */
	index(): TraceIndex {
		return new TraceIndex(this.collector.spans, (s) => this.collector.familyOf(s));
	}

	spansMatching(predicate: SpanPredicate): CollectedSpan[] {
		const index = this.index();
		return this.collector.spans.filter((s) => predicate(s, index));
	}

	/** Resolve with the first span matching `predicate`; reject after `timeout`. */
	async waitForSpan(predicate: SpanPredicate, options: WaitOptions = {}): Promise<CollectedSpan> {
		return this.waitFor(() => this.spansMatching(predicate)[0], {
			...options,
			message: options.message ?? 'span matching predicate'
		});
	}

	/**
	 * Poll `fn` until it returns a truthy value (or a promise of one), and
	 * resolve with it. A thrown error is retried until the timeout and then
	 * reported. Timeout errors include the trace summary and process output.
	 */
	async waitFor<T>(fn: () => T | Promise<T>, options: WaitOptions = {}): Promise<NonNullable<T>> {
		const timeout = options.timeout ?? 20_000;
		const interval = options.interval ?? 100;
		const deadline = Date.now() + timeout;
		let lastError: unknown;
		for (;;) {
			try {
				const v = await fn();
				if (v) return v as NonNullable<T>;
				lastError = undefined;
			} catch (e) {
				lastError = e;
			}
			if (Date.now() >= deadline) break;
			await Bun.sleep(interval);
		}
		throw new Error(
			`Timed out after ${timeout} ms waiting for ${options.message ?? 'condition'}` +
				(lastError ? `\nlast error: ${(lastError as Error).stack ?? lastError}` : '') +
				`\n${this.diagnostics()}`
		);
	}

	/** Trace summary + tail of process output, for failure messages. */
	diagnostics(): string {
		return [
			'--- app actor sessions ---',
			this.index().describe(APP_SERVICE) || '(none)',
			this.collector.errors.length ? `--- collector errors ---\n${this.collector.errors.join('\n')}` : '',
			'--- app output ---',
			this.appOutput.tail(),
			'--- fake-github output ---',
			this.fakeOutput.tail(20),
			...(this.options.loadgen ? ['--- loadgen output ---', this.loadgenOutput.tail(20)] : []),
			...(this.options.infra ? ['--- fake-infra output ---', this.infraOutput.tail(20)] : [])
		]
			.filter(Boolean)
			.join('\n');
	}

	// -------------------------------------------------------------------------
	// App helpers
	// -------------------------------------------------------------------------

	/** fetch against the app, never following redirects. */
	fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
		return fetch(`${this.appUrl}${path}`, { redirect: 'manual', ...init });
	}

	/** POST a raw webhook to the app with an explicit (possibly wrong) signature. */
	postWebhook(body: string, headers: { event?: string; deliveryId?: string; signature?: string } = {}) {
		return this.fetchApp('/webhook', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': headers.event ?? 'issues',
				'X-GitHub-Delivery': headers.deliveryId ?? crypto.randomUUID(),
				...(headers.signature !== undefined ? { 'X-Hub-Signature-256': headers.signature } : {})
			},
			body
		});
	}
}

/** Result of running the `granary` CLI (ADR 0159). */
export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The CLI entry point E1 builds (`dist/cli.js`), else its source. Null until
 * the CLI exists (tests that need it are `todo` until then).
 */
/** The built CLI (`mise run cli`; `mise run test` builds it first). */
export function cliEntry(): string {
	const entry = join(ROOT, 'dist/cli.js');
	if (!existsSync(entry)) throw new Error('dist/cli.js missing — run `mise run cli` (or `mise run test`, which builds it)');
	return entry;
}

/** Run `granary <args> --data <tmpDir>` with the app's env (socket or direct mode). */
export async function runCli(h: Harness, args: string[], opts: { env?: Record<string, string>; stdin?: string; timeout?: number } = {}): Promise<CliResult> {
	const entry = cliEntry();
	const proc = Bun.spawn(['bun', entry, ...args, '--data', h.tmpDir], {
		cwd: ROOT,
		env: { ...h.appEnv(), ...opts.env },
		stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeout ?? 20_000);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

export function signBody(body: string, secret: string): string {
	const h = new Bun.CryptoHasher('sha256', secret);
	h.update(body);
	return `sha256=${h.digest('hex')}`;
}

let counter = 0;
/** A repo name unique within this run. */
export const uniqueName = (prefix = 'repo') => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Register beforeAll/afterAll for one harness per test file; returns a
 * getter (the harness only exists once beforeAll ran).
 */
export function useHarness(options: HarnessOptions = {}): () => Harness {
	let harness: Harness | null = null;
	beforeAll(async () => {
		harness = new Harness(options);
		try {
			await harness.start();
		} catch (e) {
			await harness.stop().catch(() => undefined);
			throw e;
		}
	}, (options.bootTimeout ?? 30_000) * 2 + 10_000);
	afterAll(async () => {
		await harness?.stop();
	}, 15_000);
	return () => {
		if (!harness) throw new Error('harness not started (beforeAll failed?)');
		return harness;
	};
}
