/**
 * The GitHub connection (ADR 0160, 0190–0193): which mode granary is in,
 * where its secrets come from, how REST calls authenticate, the manifest
 * flow, installation/repo sync and the per-repo policy.
 *
 * granary talks to GitHub only as a GitHub App (ADR 0230): mode `none`
 * until the app is created in-product, then `app`. The app's credentials
 * live in the platform secret store (ADR 0158) under GITHUB_SECRET_REFS.
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
	GitHubAppInfo,
	GitHubInstallation,
	InstallationRepositories,
	PR_EVENT,
	PR_PERMISSION,
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
	type InstallationRow,
	type RepoSwitch,
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
		this.#tokens.clear();
	}

	#secretsReady(): PlatformSecrets | null {
		const store = this.#secrets();
		if (!store || store.keyStatus() !== 'ok') return null;
		return store;
	}

	// -- mode ---------------------------------------------------------------------

	mode(): GitHubMode {
		return this.#store.getMode(GITHUB_SETTING_KEYS.mode) ?? 'none';
	}

	#lastMode: GitHubMode | null = null;

	#setMode(mode: GitHubMode, by: string): void {
		this.#store.setConfigValue(GITHUB_SETTING_KEYS.mode, mode, by);
		this.refreshMode(by);
	}

	/**
	 * Re-read the mode and notify listeners when it changed. Called after
	 * anything outside this class writes `github.mode` (the admin socket's
	 * `config set`, ADR 0220), so e.g. the catch-up actor starts or stops.
	 */
	refreshMode(by = 'config'): void {
		const mode = this.mode();
		const before = this.#lastMode;
		this.#lastMode = mode;
		if (before !== null && before !== mode) {
			log.info(`github: mode ${before} → ${mode} (${by})`);
			this.#tokens.clear();
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

	/** At boot: a never-configured instance starts in mode `none` (setup required). */
	seed(): void {
		if (this.#store.getMode(GITHUB_SETTING_KEYS.mode) === null) this.#setMode('none', 'seed');
		this.refreshMode('seed');
	}

	/** A secret from the store, or null. */
	async #secret(id: string, purpose: string): Promise<string | null> {
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
		return null;
	}

	// -- inbound -------------------------------------------------------------------

	/** The HMAC secret `/webhook` verifies against, or null (→ 503). */
	async webhookSecret(): Promise<string | null> {
		return this.mode() === 'app' ? this.#secret(GITHUB_SECRET_REFS.appWebhookSecret, 'webhook verification') : null;
	}

	/**
	 * Per-repo policy for an `issues` webhook (ADR 0192). Disabled repos are
	 * ignored. An unknown repo is registered when the (signed) delivery
	 * names its installation, else ignored.
	 */
	repoPolicy(repoId: number, fullName: string, installationId: number | null, kind: RepoSwitch = 'issues'): RepoPolicy {
		let repo = this.#store.getRepo(repoId);
		if (repo) {
			if (repo.full_name !== fullName || (installationId !== null && repo.installation_id !== installationId)) {
				this.#store.upsertRepo(repoId, fullName, installationId ?? repo.installation_id);
				repo = this.#store.getRepo(repoId) ?? repo;
			}
		} else {
			if (installationId === null) return { guarded: false, reason: 'unknown repo (no installation)' };
			this.#store.upsertRepo(repoId, fullName, installationId);
			log.info(`github: registered ${fullName} (#${repoId}) from a webhook of installation ${installationId}`);
			repo = this.#store.getRepo(repoId);
			if (!repo) return { guarded: false, reason: 'unknown repo' };
		}
		if (kind === 'issues') return repo.enabled ? { guarded: true } : { guarded: false, reason: 'repo disabled' };
		// Pull requests (ADR 0280, 0281): the repo's switch and accepted PR access.
		if (!repo.prs_enabled) return { guarded: false, reason: 'pull requests disabled for this repo' };
		if (!this.#installationHasPrAccess(repo.installation_id)) return { guarded: false, reason: 'the app has no pull request access on this installation' };
		return { guarded: true };
	}

	// -- pull request access (ADR 0281) ---------------------------------------------------------

	#installationHasPrAccess(installationId: number | null): boolean {
		if (installationId === null) return false;
		const inst = this.#store.listInstallations().find((i) => i.installation_id === installationId);
		return inst ? installationPrAccess(inst) : false;
	}

	/** App-level PR permission/event, from the stored `GET /app` answer (null = unknown). */
	#appPrAccess(): { permission: boolean; event: boolean } | null {
		const app = this.#store.getApp();
		if (!app || app.permissions === null) return null;
		const perms = jsonRecord(app.permissions);
		const events = jsonArray(app.events);
		return { permission: perms[PR_PERMISSION] === 'write', event: events.includes(PR_EVENT) };
	}

	/** `https://github.com/settings/apps/<slug>/permissions` (org apps: `/organizations/<org>/settings/apps/<slug>/permissions`). */
	permissionsUrl(): string | null {
		const app = this.#store.getApp();
		if (!app) return null;
		const web = this.#config.githubWebUrl.replace(/\/+$/, '');
		const orgOwned = this.#store.listInstallations().some((i) => i.account_login.toLowerCase() === app.owner_login.toLowerCase() && i.account_type === 'Organization');
		return orgOwned
			? `${web}/organizations/${encodeURIComponent(app.owner_login)}/settings/apps/${encodeURIComponent(app.slug)}/permissions`
			: `${web}/settings/apps/${encodeURIComponent(app.slug)}/permissions`;
	}

	pullRequestAccess(): GitHubStatus['pullRequests'] {
		const app = this.#store.getApp();
		const access = this.#appPrAccess();
		if (!app || !access) return null;
		const pendingInstallations = this.#store
			.listInstallations()
			.filter((i) => !i.suspended && !installationPrAccess(i))
			.map((i) => ({ installationId: i.installation_id, account: i.account_login }));
		return {
			appPermission: access.permission,
			appEvent: access.event,
			pendingInstallations,
			permissionsUrl: this.permissionsUrl() ?? '',
			ready: access.permission && access.event && pendingInstallations.length === 0
		};
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
			// `new_permissions_accepted` carries the installation's accepted permissions (ADR 0281).
			const perms = (inst as { permissions?: unknown }).permissions;
			const evs = (inst as { events?: unknown }).events;
			if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
				this.#store.setInstallationPermissions(id, perms as Record<string, string>, Array.isArray(evs) ? (evs as string[]) : null);
				// Tokens minted before carry the old permissions.
				if (body.action === 'new_permissions_accepted') this.#tokens.invalidate(id);
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

	/** The REST client for effects on one repo (relay): an installation token. */
	async clientForRepo(target: { owner: string; repo: string; repoId: number }): Promise<GitHubClient> {
		if (this.mode() !== 'app') throw new Error('GitHub is not connected (setup required)');
		const installationId = await this.#installationFor(target.owner, target.repo, target.repoId);
		return new GitHubClient({
			apiUrl: this.#config.githubApiUrl,
			token: () => this.#tokens.get(installationId),
			onUnauthorized: () => this.#tokens.invalidate(installationId)
		});
	}

	/** OAuth client for UI sign-in: the GitHub App's user-to-server credentials. */
	async oauthCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
		if (this.mode() !== 'app') return null;
		const app = this.#store.getApp();
		const secret = app ? await this.#secret(GITHUB_SECRET_REFS.appClientSecret, 'oauth') : null;
		return app && secret ? { clientId: app.client_id, clientSecret: secret } : null;
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
			created_at: now,
			permissions: conv.permissions ? JSON.stringify(conv.permissions) : null,
			events: conv.events ? JSON.stringify(conv.events) : null
		});
		this.#tokens.clear();
		this.#setMode('app', actor);
		return { appId: conv.id, slug: conv.slug, installUrl: this.installUrl(conv.slug) };
	}

	// -- disconnect ----------------------------------------------------------------------------

	/** See `Backend.disconnectGitHub` (ADR 0220). */
	disconnect(actor: string): void {
		const store = this.#secrets();
		if (store) {
			for (const id of Object.values(GITHUB_SECRET_REFS)) {
				try {
					store.delete(id, actor);
				} catch {
					/* not stored */
				}
			}
		}
		this.#store.clearApp();
		this.#tokens.clear();
		this.#setMode('none', actor);
	}

	// -- installations -------------------------------------------------------------------------

	async refreshInstallations(actor: string): Promise<InstallationSummary[]> {
		if (this.mode() !== 'app') throw new BackendError('invalid', 'Installations exist only in GitHub App mode');
		// Refresh also re-reads what the app asks for (`GET /app`, ADR 0281): after granting
		// pull request access on GitHub, one Refresh shows it.
		this.#auth = { ...this.#auth, checkedAt: null };
		await this.#checkAuth();
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
			prAccess: installationPrAccess(i),
			repos: repos.filter((r) => r.installation_id === i.installation_id).map((r) => repoSummary(r, installationPrAccess(i))),
			syncedAt: i.synced_at
		}));
	}

	setRepoEnabled(input: SetRepoEnabledInput, actor: string): RepoSummary {
		const kind = input.kind ?? 'issues';
		const row = this.#store.setRepoEnabled(input.repoId, input.enabled, actor, Date.now(), kind);
		if (!row) throw new BackendError('not-found', `Unknown repository ${input.repoId}`);
		log.info(`github: ${row.full_name} ${kind === 'pull_requests' ? 'pull requests' : 'issues'} ${input.enabled ? 'enabled' : 'disabled'} by ${actor}`);
		return repoSummary(row, this.#installationHasPrAccess(row.installation_id));
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
		if (this.mode() !== 'app') {
			this.#auth = { ok: null, checkedAt: null, error: null };
			return;
		}
		try {
			const info = parse(GitHubAppInfo, await this.appRequest('GET', '/app'), 'GET /app');
			const app = this.#store.getApp();
			if (app) this.#store.setAppPermissions(app.app_id, info.permissions ?? {}, info.events ?? []);
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
			pullRequests: mode === 'app' ? this.pullRequestAccess() : null,
			webhookUrl: `${(this.#config.origin ?? '').replace(/\/+$/, '')}/webhook`,
			catchup: mode === 'app' ? this.catchupStatus() : null
		};
	}
}

function repoSummary(r: RepoRow, prAccess: boolean): RepoSummary {
	return {
		repoId: r.repo_id,
		fullName: r.full_name,
		installationId: r.installation_id,
		enabled: r.enabled === 1,
		prsEnabled: r.prs_enabled === 1,
		prAccess
	};
}

function jsonRecord(text: string | null): Record<string, string> {
	try {
		const v: unknown = text ? JSON.parse(text) : {};
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function jsonArray(text: string | null): string[] {
	try {
		const v: unknown = text ? JSON.parse(text) : [];
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

/** The installation accepted `pull_requests: write` and subscribes to `pull_request` (ADR 0281). */
export function installationPrAccess(i: InstallationRow): boolean {
	return jsonRecord(i.permissions)[PR_PERMISSION] === 'write' && jsonArray(i.events).includes(PR_EVENT);
}
