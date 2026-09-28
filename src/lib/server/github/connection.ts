/**
 * The GitHub connection (ADR 0160, 0190–0193): which mode granary is in,
 * where its secrets come from, how REST calls authenticate, the manifest
 * flow, installation/repo sync and the per-repo policy.
 *
 * Secrets live in the platform secret store (ADR 0158) under
 * GITHUB_SECRET_REFS. Until a store is attached (or while it has no master
 * key), token mode falls back to the legacy env values from Config — so a
 * deployment configured only by env keeps working, and so do the tests
 * (ADR 0193).
 */
import { randomBytes } from 'node:crypto';
import { BackendError } from '../backend';
import { GitHubClient, GitHubHttpError, githubRequest, nextLink } from '../github-client';
import { log } from '../log';
import type { Config } from '../../schemas/config';
import type { PlatformSecrets } from '../../platform/secrets/contract';
import {
	AppHookDelivery,
	GITHUB_APP_EVENTS,
	GITHUB_APP_PERMISSIONS,
	GITHUB_SECRET_REFS,
	GITHUB_SETTING_KEYS,
	GitHubInstallation,
	InstallationRepositories,
	InstallationToken,
	ManifestConversion,
	type BeginManifestInput,
	type CatchupStatus,
	type CompleteManifestResult,
	type GitHubAppManifest,
	type GitHubMode,
	type GitHubStatus,
	type InstallationSummary,
	type ManifestFormData,
	type RepoRow,
	type RepoSummary,
	type SetRepoEnabledInput
} from '../../schemas/github-app';
import { check, parse } from '../../schemas/standard';
import { Type } from '@sinclair/typebox';
import { InstallationTokenCache, appJwt, checkPrivateKey } from './app-jwt';
import type { GitHubStore } from './store';
import { InstallationEvent, InstallationRepositoriesEvent } from './webhooks';

export const MANIFEST_TTL_MS = 10 * 60_000;
const AUTH_CHECK_TTL_MS = 60_000;
const CATCHUP_STATUS_KEY = 'github.catchup.status';

const CatchupStatusJson = Type.Object({
	lastPassAt: Type.Union([Type.Number(), Type.Null()]),
	lastPassRedelivered: Type.Integer(),
	totalRedelivered: Type.Integer(),
	lastError: Type.Union([Type.String(), Type.Null()])
});

/** Where an `issues` webhook's repo stands (ADR 0192). */
export type RepoPolicy = { guarded: true } | { guarded: false; reason: string };

export interface GitHubConnectionOptions {
	config: Config;
	store: GitHubStore;
	/**
	 * The granary.sqlite platform secret store, looked up at the moment of use
	 * (it is opened by boot, possibly after the runtime). Null = not available.
	 */
	secrets?: () => PlatformSecrets | null;
}

export class GitHubConnection {
	readonly #config: Config;
	readonly #store: GitHubStore;
	#secrets: () => PlatformSecrets | null;
	#seedsCopied = false;
	#tokens: InstallationTokenCache;
	#auth: GitHubStatus['auth'] = { ok: null, checkedAt: null, error: null };
	#modeListeners = new Set<(mode: GitHubMode) => void>();

	constructor(opts: GitHubConnectionOptions) {
		this.#config = opts.config;
		this.#store = opts.store;
		this.#secrets = opts.secrets ?? (() => null);
		this.#tokens = new InstallationTokenCache((id) => this.#fetchInstallationToken(id));
	}

	get store(): GitHubStore {
		return this.#store;
	}

	/** Replace the secret-store lookup (tests / alternative wiring). */
	attachSecrets(secrets: () => PlatformSecrets | null): void {
		this.#secrets = secrets;
		this.#seedsCopied = false;
		this.#tokens.clear();
	}

	#secretsReady(): PlatformSecrets | null {
		const store = this.#secrets();
		if (!store || store.keyStatus() !== 'ok') return null;
		if (!this.#seedsCopied) {
			this.#seedsCopied = true;
			void this.#copySeedSecrets(store).catch((e) => log.error('github: copying seed secrets failed', e));
		}
		return store;
	}

	// -- mode ---------------------------------------------------------------------

	mode(): GitHubMode {
		return this.#store.getMode(GITHUB_SETTING_KEYS.mode) ?? 'none';
	}

	#setMode(mode: GitHubMode, by: string): void {
		const before = this.mode();
		this.#store.setConfigValue(GITHUB_SETTING_KEYS.mode, mode, by);
		if (before !== mode) {
			log.info(`github: mode ${before} → ${mode} (${by})`);
			for (const l of this.#modeListeners) {
				try {
					l(mode);
				} catch (e) {
					log.error('github: mode listener failed', e);
				}
			}
		}
	}

	onModeChange(listener: (mode: GitHubMode) => void): () => void {
		this.#modeListeners.add(listener);
		return () => this.#modeListeners.delete(listener);
	}

	/**
	 * Seeds (ADR 0193), run at boot: a never-configured instance with the
	 * legacy env (`GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET`) becomes `token`
	 * mode; with a usable secret store the env secrets are copied into it
	 * (never overwriting). Otherwise the mode stays `none` (setup required).
	 */
	seed(): void {
		const c = this.#config;
		if (this.#store.getMode(GITHUB_SETTING_KEYS.mode) === null) {
			if (c.githubToken && c.webhookSecret) {
				this.#setMode('token', 'seed');
			} else {
				this.#setMode('none', 'seed');
			}
		}
		if (this.mode() === 'token' && c.oauthClientId && !this.#store.getConfigValue(GITHUB_SETTING_KEYS.tokenOauthClientId)) {
			this.#store.setConfigValue(GITHUB_SETTING_KEYS.tokenOauthClientId, c.oauthClientId, 'seed');
		}
		this.#secretsReady(); // copies env secrets into the store when it is already open
	}

	/** Token mode: copy the legacy env secrets into the store once (never overwriting). */
	async #copySeedSecrets(store: PlatformSecrets): Promise<void> {
		if (this.mode() !== 'token') return;
		const c = this.#config;
		const copies: [string, string, string, string][] = [
			[GITHUB_SECRET_REFS.token, 'GitHub token (seed)', 'github-token', c.githubToken],
			[GITHUB_SECRET_REFS.tokenWebhookSecret, 'GitHub webhook secret (seed)', 'github-webhook-secret', c.webhookSecret],
			[GITHUB_SECRET_REFS.tokenOauthClientSecret, 'GitHub OAuth client secret (seed)', 'github-oauth-client-secret', c.oauthClientSecret]
		];
		for (const [id, name, kind, value] of copies) {
			if (value && !store.has(id)) await store.set({ id, name, kind, value }, 'seed');
		}
	}

	/** A secret from the store, else (token mode only) the legacy env value, else null. */
	async #secret(id: string, purpose: string, envFallback?: string): Promise<string | null> {
		const store = this.#secretsReady();
		if (store?.has(id)) {
			try {
				const v = await store.reveal(id, purpose);
				store.recordUse(id, true);
				return v;
			} catch (e) {
				store.recordUse(id, false);
				log.error(`github: could not reveal secret ${id} for ${purpose}`, e);
				return null;
			}
		}
		return envFallback ? envFallback : null;
	}

	// -- inbound -------------------------------------------------------------------

	/** The HMAC secret `/webhook` verifies against, or null (→ 503). */
	async webhookSecret(): Promise<string | null> {
		switch (this.mode()) {
			case 'app':
				return this.#secret(GITHUB_SECRET_REFS.appWebhookSecret, 'webhook verification');
			case 'token':
				return this.#secret(GITHUB_SECRET_REFS.tokenWebhookSecret, 'webhook verification', this.#config.webhookSecret);
			default:
				return null;
		}
	}

	/**
	 * Per-repo policy for an `issues` webhook (ADR 0192). Disabled repos are
	 * ignored in every mode. In app mode an unknown repo is registered when
	 * the (signed) delivery names its installation, else ignored; token mode
	 * has no repo inventory, so unknown repos are guarded.
	 */
	repoPolicy(repoId: number, fullName: string, installationId: number | null): RepoPolicy {
		const repo = this.#store.getRepo(repoId);
		if (repo) {
			if (!repo.enabled) return { guarded: false, reason: 'repo disabled' };
			if (repo.full_name !== fullName || (installationId !== null && repo.installation_id !== installationId)) {
				this.#store.upsertRepo(repoId, fullName, installationId ?? repo.installation_id);
			}
			return { guarded: true };
		}
		if (this.mode() !== 'app') return { guarded: true };
		if (installationId === null) return { guarded: false, reason: 'unknown repo (no installation)' };
		this.#store.upsertRepo(repoId, fullName, installationId);
		log.info(`github: registered ${fullName} (#${repoId}) from a webhook of installation ${installationId}`);
		return { guarded: true };
	}

	/** Sync from `installation` / `installation_repositories` webhooks. Returns a short note. */
	applyLifecycleEvent(event: string, body: unknown): string {
		if (event === 'installation' && check(InstallationEvent, body)) {
			const inst = body.installation;
			const id = inst.id;
			if (body.action === 'deleted') {
				this.#store.deleteInstallation(id);
				this.#tokens.invalidate(id);
				return `installation ${id} deleted`;
			}
			if (inst.account && inst.repository_selection) {
				this.#store.upsertInstallation({
					id,
					account: inst.account,
					repository_selection: inst.repository_selection,
					suspended_at: body.action === 'suspend' ? new Date().toISOString() : body.action === 'unsuspend' ? null : (inst.suspended_at ?? null)
				});
			} else if (body.action === 'suspend' || body.action === 'unsuspend') {
				this.#store.setInstallationSuspended(id, body.action === 'suspend');
			}
			for (const r of body.repositories ?? []) this.#store.upsertRepo(r.id, r.full_name, id);
			return `installation ${id} ${body.action}`;
		}
		if (event === 'installation_repositories' && check(InstallationRepositoriesEvent, body)) {
			const id = body.installation.id;
			for (const r of body.repositories_added ?? []) this.#store.upsertRepo(r.id, r.full_name, id);
			for (const r of body.repositories_removed ?? []) this.#store.detachRepo(r.id);
			return `installation ${id} repositories ${body.action}`;
		}
		return `${event}: payload not understood`;
	}

	// -- outbound auth -----------------------------------------------------------------

	async #appCredentials(): Promise<{ appId: number; pem: string }> {
		const app = this.#store.getApp();
		if (!app) throw new BackendError('unavailable', 'No GitHub App is configured');
		const pem = await this.#secret(GITHUB_SECRET_REFS.appPrivateKey, 'app JWT');
		if (!pem) throw new BackendError('unavailable', 'The GitHub App private key is not available (master key missing?)');
		return { appId: app.app_id, pem };
	}

	/** A call authenticated as the app (JWT). */
	async appRequest(method: string, path: string, body?: unknown, onHeaders?: (h: Headers) => void): Promise<unknown> {
		const { appId, pem } = await this.#appCredentials();
		return githubRequest({ apiUrl: this.#config.githubApiUrl, token: appJwt(appId, pem), onHeaders }, method, path, body);
	}

	async #fetchInstallationToken(installationId: number): Promise<{ token: string; expiresAt: number }> {
		const res = parse(InstallationToken, await this.appRequest('POST', `/app/installations/${installationId}/access_tokens`), 'installation token');
		const expiresAt = Date.parse(res.expires_at);
		return { token: res.token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 50 * 60_000 : expiresAt };
	}

	/** The installation of a repo: stored, else `GET /repos/{owner}/{repo}/installation` (JWT). */
	async #installationFor(owner: string, repo: string, repoId: number): Promise<number> {
		const known = this.#store.getRepo(repoId)?.installation_id;
		if (known) return known;
		const res = (await this.appRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`)) as { id?: unknown };
		if (typeof res?.id !== 'number') throw new Error(`no installation found for ${owner}/${repo}`);
		this.#store.upsertRepo(repoId, `${owner}/${repo}`, res.id);
		return res.id;
	}

	/** The REST client for effects on one repo (relay), by mode. */
	async clientForRepo(target: { owner: string; repo: string; repoId: number }): Promise<GitHubClient> {
		const apiUrl = this.#config.githubApiUrl;
		switch (this.mode()) {
			case 'token': {
				const token = await this.#secret(GITHUB_SECRET_REFS.token, 'relay', this.#config.githubToken);
				if (!token) throw new Error('GitHub token is not configured');
				return new GitHubClient({ apiUrl, token });
			}
			case 'app': {
				const installationId = await this.#installationFor(target.owner, target.repo, target.repoId);
				return new GitHubClient({
					apiUrl,
					token: () => this.#tokens.get(installationId),
					onUnauthorized: () => this.#tokens.invalidate(installationId)
				});
			}
			default:
				throw new Error('GitHub is not connected (setup required)');
		}
	}

	/** OAuth client for UI sign-in: the app's (app mode) or the separate OAuth app (token mode). */
	async oauthCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
		switch (this.mode()) {
			case 'app': {
				const app = this.#store.getApp();
				const secret = app ? await this.#secret(GITHUB_SECRET_REFS.appClientSecret, 'oauth') : null;
				return app && secret ? { clientId: app.client_id, clientSecret: secret } : null;
			}
			case 'token': {
				const clientId = this.#store.getConfigValue(GITHUB_SETTING_KEYS.tokenOauthClientId) || this.#config.oauthClientId;
				const secret = await this.#secret(GITHUB_SECRET_REFS.tokenOauthClientSecret, 'oauth', this.#config.oauthClientSecret);
				return clientId && secret ? { clientId, clientSecret: secret } : null;
			}
			default:
				return null;
		}
	}

	// -- manifest flow (ADR 0160) -----------------------------------------------------------

	#origin(): string {
		const origin = this.#config.origin;
		if (!origin) throw new BackendError('invalid', 'ORIGIN must be set to the public URL before creating a GitHub App');
		return origin.replace(/\/+$/, '');
	}

	manifest(name?: string): GitHubAppManifest {
		const origin = this.#origin();
		const host = new URL(origin).host.replace(/[^a-z0-9-]/gi, '-');
		return {
			name: (name ?? `granary-${host}`).slice(0, 34),
			url: origin,
			hook_attributes: { url: `${origin}/webhook`, active: true },
			redirect_url: `${origin}/settings/github/callback`,
			callback_urls: [`${origin}/auth/callback`],
			setup_url: `${origin}/settings/github/installed`,
			description: 'granary closes issues opened by users who are not on the allowlist.',
			public: false,
			request_oauth_on_install: false,
			setup_on_update: true,
			default_permissions: { ...GITHUB_APP_PERMISSIONS },
			default_events: [...GITHUB_APP_EVENTS]
		};
	}

	beginManifest(input: BeginManifestInput, requestedBy: string, now = Date.now()): ManifestFormData {
		if (this.#store.getApp()) throw new BackendError('conflict', 'A GitHub App is already configured');
		const manifest = this.manifest(input.name);
		const state = randomBytes(24).toString('base64url');
		const expiresAt = now + MANIFEST_TTL_MS;
		this.#store.insertManifestState({ state, created_by: requestedBy, created_at: now, expires_at: expiresAt, used_at: null });
		const web = this.#config.githubWebUrl;
		const base = input.organization ? `${web}/organizations/${encodeURIComponent(input.organization)}/settings/apps/new` : `${web}/settings/apps/new`;
		return { postUrl: `${base}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest), state, expiresAt };
	}

	installUrl(slug: string): string {
		return `${this.#config.githubWebUrl}/apps/${encodeURIComponent(slug)}/installations/new`;
	}

	async completeManifest(code: string, state: string, actor: string, now = Date.now()): Promise<CompleteManifestResult> {
		const row = this.#store.consumeManifestState(state, now);
		if (!row || row.used_at !== null || row.expires_at < now) {
			throw new BackendError('invalid', 'This GitHub App setup link is unknown, used or expired — start again from Settings → GitHub');
		}
		if (row.created_by.toLowerCase() !== actor.toLowerCase()) {
			throw new BackendError('invalid', 'This GitHub App setup was started by another admin');
		}
		if (this.#store.getApp()) throw new BackendError('conflict', 'A GitHub App is already configured');
		const secrets = this.#secretsReady();
		if (!secrets) throw new BackendError('unavailable', 'The secret store is not available (is the master key configured?)');
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new BackendError('invalid', 'Malformed code');

		let conv: ManifestConversion;
		try {
			conv = parse(
				ManifestConversion,
				await githubRequest({ apiUrl: this.#config.githubApiUrl, token: '' }, 'POST', `/app-manifests/${code}/conversions`),
				'manifest conversion'
			);
		} catch (e) {
			throw new BackendError('upstream', `GitHub did not accept the app code: ${(e as Error).message}`);
		}
		checkPrivateKey(conv.pem);
		if (!conv.webhook_secret) throw new BackendError('upstream', 'GitHub returned no webhook secret for the new app');

		await secrets.set({ id: GITHUB_SECRET_REFS.appPrivateKey, name: `GitHub App ${conv.slug} private key`, kind: 'github-app-private-key', value: conv.pem }, actor);
		await secrets.set({ id: GITHUB_SECRET_REFS.appWebhookSecret, name: `GitHub App ${conv.slug} webhook secret`, kind: 'github-app-webhook-secret', value: conv.webhook_secret }, actor);
		await secrets.set({ id: GITHUB_SECRET_REFS.appClientSecret, name: `GitHub App ${conv.slug} client secret`, kind: 'github-app-client-secret', value: conv.client_secret }, actor);
		this.#store.insertApp({
			app_id: conv.id,
			slug: conv.slug,
			name: conv.name,
			html_url: conv.html_url,
			owner_login: conv.owner.login,
			client_id: conv.client_id,
			created_by: actor,
			created_at: now
		});
		this.#tokens.clear();
		this.#setMode('app', actor);
		return { appId: conv.id, slug: conv.slug, installUrl: this.installUrl(conv.slug) };
	}

	// -- installations -------------------------------------------------------------------------

	async refreshInstallations(actor: string): Promise<InstallationSummary[]> {
		if (this.mode() !== 'app') throw new BackendError('invalid', 'Installations exist only in GitHub App mode');
		const seen: number[] = [];
		let path: string | null = '/app/installations?per_page=100';
		try {
			while (path) {
				let link: string | null = null;
				const list = parse(Type.Array(GitHubInstallation), await this.appRequest('GET', path, undefined, (h) => (link = h.get('link'))), 'installations');
				for (const inst of list) {
					this.#store.upsertInstallation(inst);
					seen.push(inst.id);
					if (!inst.suspended_at) await this.#syncRepos(inst.id);
				}
				path = this.#relative(nextLink(link));
			}
		} catch (e) {
			if (e instanceof BackendError) throw e;
			throw new BackendError('upstream', `Could not list installations: ${(e as Error).message}`);
		}
		for (const inst of this.#store.listInstallations()) if (!seen.includes(inst.installation_id)) this.#store.deleteInstallation(inst.installation_id);
		log.info(`github: installations refreshed by ${actor} (${seen.length})`);
		return this.installations();
	}

	async #syncRepos(installationId: number): Promise<void> {
		const token = await this.#tokens.get(installationId);
		const ids: number[] = [];
		let path: string | null = '/installation/repositories?per_page=100';
		while (path) {
			let link: string | null = null;
			const res = parse(
				InstallationRepositories,
				await githubRequest({ apiUrl: this.#config.githubApiUrl, token, onHeaders: (h) => (link = h.get('link')) }, 'GET', path),
				'installation repositories'
			);
			for (const r of res.repositories) {
				this.#store.upsertRepo(r.id, r.full_name, installationId);
				ids.push(r.id);
			}
			path = this.#relative(nextLink(link));
		}
		this.#store.detachReposExcept(installationId, ids);
	}

	/** GitHub's `Link` URLs are absolute; githubRequest wants a path under the API URL. */
	#relative(url: string | null): string | null {
		if (!url) return null;
		const api = this.#config.githubApiUrl.replace(/\/+$/, '');
		return url.startsWith(api) ? url.slice(api.length) : new URL(url).pathname + new URL(url).search;
	}

	installations(): InstallationSummary[] {
		const repos = this.#store.listRepos();
		return this.#store.listInstallations().map((i) => ({
			installationId: i.installation_id,
			account: i.account_login,
			accountType: i.account_type,
			repositorySelection: i.repository_selection,
			suspended: i.suspended === 1,
			repos: repos.filter((r) => r.installation_id === i.installation_id).map(repoSummary),
			syncedAt: i.synced_at
		}));
	}

	setRepoEnabled(input: SetRepoEnabledInput, actor: string): RepoSummary {
		const row = this.#store.setRepoEnabled(input.repoId, input.enabled, actor);
		if (!row) throw new BackendError('not-found', `Unknown repository ${input.repoId}`);
		log.info(`github: ${row.full_name} ${input.enabled ? 'enabled' : 'disabled'} by ${actor}`);
		return repoSummary(row);
	}

	// -- app hook deliveries (ADR 0162) ------------------------------------------------------------

	/** One page of `GET /app/hook/deliveries`; `next` is the path of the following page. */
	async hookDeliveries(path = '/app/hook/deliveries?per_page=100'): Promise<{ items: AppHookDelivery[]; next: string | null }> {
		let link: string | null = null;
		const items = parse(Type.Array(AppHookDelivery), await this.appRequest('GET', path, undefined, (h) => (link = h.get('link'))), 'hook deliveries');
		return { items, next: this.#relative(nextLink(link)) };
	}

	async redeliver(deliveryId: number): Promise<void> {
		await this.appRequest('POST', `/app/hook/deliveries/${deliveryId}/attempts`);
	}

	catchupStatus(): CatchupStatus | null {
		return this.#store.getJson(CATCHUP_STATUS_KEY, (v): v is CatchupStatus => check(CatchupStatusJson, v));
	}

	recordCatchupPass(pass: { at: number; redelivered: number; error: string | null }): void {
		const prev = this.catchupStatus();
		const next: CatchupStatus = {
			lastPassAt: pass.at,
			lastPassRedelivered: pass.redelivered,
			totalRedelivered: (prev?.totalRedelivered ?? 0) + pass.redelivered,
			lastError: pass.error
		};
		this.#store.setSetting(CATCHUP_STATUS_KEY, JSON.stringify(next), 'catchup');
	}

	checkpoint(): number | null {
		const v = Number(this.#store.getSetting(GITHUB_SETTING_KEYS.catchupCheckpoint));
		return Number.isFinite(v) && v > 0 ? v : null;
	}

	setCheckpoint(at: number): void {
		this.#store.setSetting(GITHUB_SETTING_KEYS.catchupCheckpoint, String(at), 'catchup');
	}

	// -- status ------------------------------------------------------------------------------

	async #checkAuth(): Promise<void> {
		const now = Date.now();
		if (this.#auth.checkedAt && now - this.#auth.checkedAt < AUTH_CHECK_TTL_MS) return;
		const mode = this.mode();
		try {
			if (mode === 'app') await this.appRequest('GET', '/app');
			else if (mode === 'token') {
				const token = await this.#secret(GITHUB_SECRET_REFS.token, 'status', this.#config.githubToken);
				if (!token) throw new Error('GitHub token is not configured');
				await githubRequest({ apiUrl: this.#config.githubApiUrl, token }, 'GET', '/user');
			} else {
				this.#auth = { ok: null, checkedAt: null, error: null };
				return;
			}
			this.#auth = { ok: true, checkedAt: now, error: null };
		} catch (e) {
			const message = e instanceof GitHubHttpError ? `HTTP ${e.status}` : (e as Error).message;
			this.#auth = { ok: false, checkedAt: now, error: message.slice(0, 300) };
		}
	}

	async status(): Promise<GitHubStatus> {
		await this.#checkAuth();
		const mode = this.mode();
		const app = this.#store.getApp();
		return {
			mode,
			app: app
				? {
						appId: app.app_id,
						slug: app.slug,
						name: app.name,
						htmlUrl: app.html_url,
						owner: app.owner_login,
						installUrl: this.installUrl(app.slug),
						createdAt: app.created_at
					}
				: null,
			auth: { ...this.#auth },
			installations: this.installations(),
			webhookUrl: `${(this.#config.origin ?? '').replace(/\/+$/, '')}/webhook`,
			catchup: mode === 'app' ? this.catchupStatus() : null
		};
	}
}

function repoSummary(r: RepoRow): RepoSummary {
	return { repoId: r.repo_id, fullName: r.full_name, installationId: r.installation_id, enabled: r.enabled === 1 };
}
