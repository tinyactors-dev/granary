/**
 * In-memory setup/admins/login-links/GitHub-connection data for StubBackend
 * (ADR 0161, 0160, 0166). Lets the settings UI (fork E5) be built before the
 * real implementations (forks E1, E3) exist. Mutations behave plausibly:
 * creating a manifest then "completing" it switches the mode to `app`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BackendError } from './backend';
import type {
	AddAdminResult,
	Admin,
	AuditEntry,
	CreatedLoginLink,
	CreateLoginLinkInput,
	LoginLinkSummary,
	RemoveAdminResult,
	RevokeLoginLinkResult,
	SetupStatus
} from '$lib/schemas/admins';
import { LOGIN_LINK_DEFAULT_TTL_MS, LOGIN_LINK_PATH } from '$lib/schemas/admins';
import type {
	BeginManifestInput,
	CompleteManifestResult,
	GitHubMode,
	GitHubStatus,
	InstallationSummary,
	ManifestFormData,
	RepoSummary,
	SetRepoEnabledInput
} from '$lib/schemas/github-app';
import { GITHUB_APP_EVENTS, GITHUB_APP_PERMISSIONS } from '$lib/schemas/github-app';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface StubSettingsOptions {
	admins: string[];
	origin: string;
	githubWebUrl: string;
	/** Start in `none` (setup wizard) instead of a connected app. */
	mode?: GitHubMode;
}

export class StubSettings {
	#admins = new Map<string, Admin>();
	#links = new Map<string, { login: string; expiresAt: number; used: boolean; createdBy: string; createdAt: number; usedAt: number | null; revokedAt: number | null }>();
	#audit: AuditEntry[] = [];
	#mode: GitHubMode;
	#app: GitHubStatus['app'] = null;
	#installations: InstallationSummary[] = [];
	#states = new Map<string, number>();
	readonly #origin: string;
	readonly #web: string;

	constructor(o: StubSettingsOptions) {
		this.#origin = o.origin.replace(/\/+$/, '');
		this.#web = o.githubWebUrl.replace(/\/+$/, '');
		const now = Date.now();
		for (const login of o.admins) this.#admins.set(login.toLowerCase(), { login, addedBy: 'seed', addedAt: now - 86_400_000, source: 'seed' });
		this.#mode = o.mode ?? 'app';
		if (this.#mode === 'app') this.#connect(412345, 'granary-demo', now - 3_600_000);
	}

	#connect(appId: number, slug: string, at: number) {
		this.#mode = 'app';
		this.#app = { appId, slug, name: slug, htmlUrl: `${this.#web}/apps/${slug}`, owner: 'acme', installUrl: `${this.#web}/apps/${slug}/installations/new`, createdAt: at };
		this.#installations = [
			{
				installationId: 9001,
				account: 'acme',
				accountType: 'Organization',
				repositorySelection: 'selected',
				suspended: false,
				syncedAt: at,
				repos: [
					{ repoId: 1001, fullName: 'acme/widgets', installationId: 9001, enabled: true },
					{ repoId: 1002, fullName: 'acme/gadgets', installationId: 9001, enabled: true },
					{ repoId: 1003, fullName: 'acme/sandbox', installationId: 9001, enabled: false }
				]
			}
		];
	}

	#log(actor: string, action: AuditEntry['action'], subject: string, detail: unknown = null) {
		this.#audit.unshift({ id: this.#audit.length + 1, at: Date.now(), actor, action, subject, detail });
	}

	isAdmin(login: string): boolean {
		return this.#admins.has(login.toLowerCase());
	}

	async getSetupStatus(): Promise<SetupStatus> {
		return { state: this.#mode === 'none' ? 'needs-github' : 'ready', origin: this.#origin, masterKey: 'ok', adminCount: this.#admins.size };
	}
	async listAdmins(): Promise<Admin[]> {
		return [...this.#admins.values()].sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
	}
	async addAdmin(login: string, addedBy: string, source: Admin['source']): Promise<AddAdminResult> {
		if (!LOGIN_RE.test(login)) throw new BackendError('invalid', 'Not a valid GitHub login');
		const existing = this.#admins.get(login.toLowerCase());
		if (existing) return { admin: existing, added: false };
		const admin: Admin = { login, addedBy, addedAt: Date.now(), source };
		this.#admins.set(login.toLowerCase(), admin);
		this.#log(addedBy, 'admin.add', login);
		return { admin, added: true };
	}
	async removeAdmin(login: string, removedBy: string): Promise<RemoveAdminResult> {
		if (!this.#admins.has(login.toLowerCase())) return { login, removed: false };
		if (this.#admins.size <= 1) throw new BackendError('conflict', 'Cannot remove the last admin');
		this.#admins.delete(login.toLowerCase());
		this.#log(removedBy, 'admin.remove', login);
		return { login, removed: true };
	}
	async createLoginLink(input: CreateLoginLinkInput, createdBy: string): Promise<CreatedLoginLink> {
		if (!this.isAdmin(input.login)) throw new BackendError('invalid', `${input.login} is not an admin`);
		const token = randomBytes(32).toString('base64url');
		const expiresAt = Date.now() + (input.ttlMs ?? LOGIN_LINK_DEFAULT_TTL_MS);
		this.#links.set(token, { login: input.login, expiresAt, used: false, createdBy, createdAt: Date.now(), usedAt: null, revokedAt: null });
		this.#log(createdBy, 'login-link.create', input.login);
		return { url: `${this.#origin}${LOGIN_LINK_PATH}/${token}`, login: input.login, expiresAt };
	}
	/** Returns the login to create a session for, or null. */
	takeLoginLink(token: string): string | null {
		const link = this.#links.get(token);
		if (!link || link.used || link.revokedAt !== null || link.expiresAt < Date.now() || !this.isAdmin(link.login)) return null;
		link.used = true;
		link.usedAt = Date.now();
		this.#log(link.login, 'login-link.use', link.login);
		return link.login;
	}
	async listAuditLog(limit: number): Promise<AuditEntry[]> {
		return this.#audit.slice(0, limit);
	}
	async listLoginLinks(limit: number): Promise<LoginLinkSummary[]> {
		const now = Date.now();
		return [...this.#links.entries()]
			.map(([token, l]) => ({
				id: createHash('sha256').update(token).digest('hex').slice(0, 16),
				login: l.login,
				createdBy: l.createdBy,
				createdAt: l.createdAt,
				expiresAt: l.expiresAt,
				usedAt: l.usedAt,
				revokedAt: l.revokedAt,
				state: (l.revokedAt !== null ? 'revoked' : l.used ? 'used' : l.expiresAt <= now ? 'expired' : 'valid') as LoginLinkSummary['state']
			}))
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	}
	async revokeLoginLink(id: string, revokedBy: string): Promise<RevokeLoginLinkResult> {
		for (const [token, l] of this.#links) {
			if (createHash('sha256').update(token).digest('hex').slice(0, 16) !== id) continue;
			if (l.used || l.revokedAt !== null || l.expiresAt <= Date.now()) return { id, revoked: false };
			l.revokedAt = Date.now();
			this.#log(revokedBy, 'login-link.revoke', l.login);
			return { id, revoked: true };
		}
		throw new BackendError('not-found', `login link ${id} not found`);
	}

	async getGitHubStatus(): Promise<GitHubStatus> {
		return {
			mode: this.#mode,
			app: this.#app,
			auth: this.#mode === 'none' ? { ok: null, checkedAt: null, error: null } : { ok: true, checkedAt: Date.now() - 60_000, error: null },
			installations: this.#installations,
			webhookUrl: `${this.#origin}/webhook`,
			catchup: this.#mode === 'app' ? { lastPassAt: Date.now() - 240_000, lastPassRedelivered: 0, totalRedelivered: 3, lastError: null } : null
		};
	}
	async beginGitHubAppManifest(input: BeginManifestInput, _requestedBy: string): Promise<ManifestFormData> {
		const state = randomBytes(16).toString('base64url');
		const expiresAt = Date.now() + 10 * 60_000;
		this.#states.set(state, expiresAt);
		const host = new URL(this.#origin).host.replace(/[^a-z0-9-]/gi, '-');
		const manifest = {
			name: (input.name ?? `granary-${host}`).slice(0, 34),
			url: this.#origin,
			hook_attributes: { url: `${this.#origin}/webhook`, active: true },
			redirect_url: `${this.#origin}/settings/github/callback`,
			callback_urls: [`${this.#origin}/auth/callback`],
			setup_url: `${this.#origin}/settings/github/installed`,
			public: false,
			request_oauth_on_install: false,
			default_permissions: { ...GITHUB_APP_PERMISSIONS },
			default_events: [...GITHUB_APP_EVENTS]
		};
		const base = input.organization ? `${this.#web}/organizations/${input.organization}/settings/apps/new` : `${this.#web}/settings/apps/new`;
		return { postUrl: `${base}?state=${state}`, manifest: JSON.stringify(manifest), state, expiresAt };
	}
	async completeGitHubAppManifest(_code: string, state: string, actor: string): Promise<CompleteManifestResult> {
		const exp = this.#states.get(state);
		if (!exp || exp < Date.now()) throw new BackendError('invalid', 'Unknown or expired setup state');
		this.#states.delete(state);
		if (this.#mode === 'app') throw new BackendError('conflict', 'A GitHub App is already connected');
		this.#connect(512345, 'granary-new', Date.now());
		this.#log(actor, 'github.app.create', 'granary-new');
		return { appId: 512345, slug: 'granary-new', installUrl: this.#app!.installUrl };
	}
	async disconnectGitHub(actor: string): Promise<GitHubStatus> {
		const before = this.#mode;
		this.#mode = 'none';
		this.#app = null;
		this.#installations = [];
		this.#log(actor, 'github.disconnect', before);
		return this.getGitHubStatus();
	}
	async refreshGitHubInstallations(_actor: string): Promise<InstallationSummary[]> {
		for (const i of this.#installations) i.syncedAt = Date.now();
		return this.#installations;
	}
	async setRepoEnabled(input: SetRepoEnabledInput, actor: string): Promise<RepoSummary> {
		for (const i of this.#installations) {
			const repo = i.repos.find((r) => r.repoId === input.repoId);
			if (repo) {
				repo.enabled = input.enabled;
				this.#log(actor, input.enabled ? 'github.repo.enable' : 'github.repo.disable', repo.fullName);
				return repo;
			}
		}
		throw new BackendError('not-found', `Unknown repository ${input.repoId}`);
	}
}
