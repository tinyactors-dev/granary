/**
 * Remote functions for /settings (ADR 0160, 0161, 0210).
 *
 * Thin: validate with TypeBox (`standard()`), authorize, delegate to the
 * Backend. Reads need a signed-in user (the setup status and GitHub status
 * contain no secrets); every mutation needs an admin. The login-link URL is
 * returned exactly once by `createLoginLink` and never cached in a query.
 */
import { command, form, query } from '$app/server';
import { error, invalid } from '@sveltejs/kit';
import { Type } from '@sinclair/typebox';
import { standard } from '$lib/schemas/standard';
import { Login } from '$lib/schemas/github';
import {
	AddAdminInput,
	LOGIN_LINK_DEFAULT_TTL_MS,
	LOGIN_LINK_MAX_TTL_MS,
	type AddAdminResult,
	type Admin,
	type AuditEntry,
	type CreatedLoginLink,
	type RemoveAdminResult,
	type SetupStatus
} from '$lib/schemas/admins';
import {
	BeginManifestInput,
	SetRepoEnabledInput,
	type GitHubStatus,
	type InstallationSummary,
	type ManifestFormData,
	type RepoSummary
} from '$lib/schemas/github-app';
import { currentUser, requireAdmin, requireUser } from '$lib/server/auth';
import { backendErrorStatus, getBackend, hasBackend, isBackendError } from '$lib/server/backend';
import { withBackend } from '$lib/server/remote-helpers';

// ---------------------------------------------------------------------------
// Setup state (first run, ADR 0161)
// ---------------------------------------------------------------------------

/** Signed-in users; null for anonymous visitors or before a backend exists (banner-safe). */
export const getSetupStatus = query(async (): Promise<SetupStatus | null> => {
	if (!currentUser() || !hasBackend()) return null;
	return withBackend((b) => b.getSetupStatus());
});

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

export const listAdmins = query(async (): Promise<Admin[]> => {
	requireUser();
	return withBackend((b) => b.listAdmins());
});

/** Form with one field, `login`. Idempotent (`added: false` when already an admin). */
export const addAdmin = form(standard(AddAdminInput), async ({ login }, issue): Promise<AddAdminResult> => {
	const admin = requireAdmin();
	let result: AddAdminResult;
	try {
		result = await getBackend().addAdmin(login, admin.login, 'ui');
	} catch (e) {
		if (isBackendError(e) && (e.code === 'invalid' || e.code === 'conflict')) invalid(issue.login(e.message));
		if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
		throw e;
	}
	await Promise.all([listAdmins().refresh(), getSetupStatus().refresh(), listAuditLog({}).refresh()]);
	return result;
});

/** `conflict` (409) when it would remove the last admin. */
export const removeAdmin = command(
	standard(Type.Object({ login: Login }, { additionalProperties: false })),
	async ({ login }): Promise<RemoveAdminResult> => {
		const admin = requireAdmin();
		const result = await withBackend((b) => b.removeAdmin(login, admin.login));
		await Promise.all([listAdmins().refresh(), getSetupStatus().refresh(), listAuditLog({}).refresh()]);
		return result;
	}
);

// ---------------------------------------------------------------------------
// Login links (shown once)
// ---------------------------------------------------------------------------

const CreateLoginLinkForm = Type.Object(
	{
		login: Login,
		/** Minutes, as a string from the form select. */
		ttlMinutes: Type.Optional(Type.String({ pattern: '^[0-9]{1,4}$' }))
	},
	{ additionalProperties: false }
);

/**
 * Form `{login, ttlMinutes?}`. Admin only. The result holds the only copy of
 * the URL; the page shows it once and it is gone after navigation.
 */
export const createLoginLink = form(standard(CreateLoginLinkForm), async ({ login, ttlMinutes }, issue): Promise<CreatedLoginLink> => {
	const admin = requireAdmin();
	const minutes = ttlMinutes ? Number(ttlMinutes) : LOGIN_LINK_DEFAULT_TTL_MS / 60_000;
	const ttlMs = minutes * 60_000;
	if (ttlMs < 60_000 || ttlMs > LOGIN_LINK_MAX_TTL_MS) invalid(issue.ttlMinutes('Between 1 minute and 24 hours'));
	let link: CreatedLoginLink;
	try {
		link = await getBackend().createLoginLink({ login, ttlMs }, admin.login);
	} catch (e) {
		if (isBackendError(e) && e.code === 'invalid') invalid(issue.login(e.message));
		if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
		throw e;
	}
	await listAuditLog({}).refresh();
	return link;
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const AuditInput = Type.Object(
	{ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) },
	{ additionalProperties: false }
);

/** Admin only (it names who did what). Newest first. */
export const listAuditLog = query(standard(AuditInput), async ({ limit }): Promise<AuditEntry[]> => {
	requireAdmin();
	return withBackend((b) => b.listAuditLog(limit ?? 100));
});

// ---------------------------------------------------------------------------
// GitHub connection (ADR 0160)
// ---------------------------------------------------------------------------

/** Connection mode, app details, installations and repos. No secrets. */
export const getGitHubStatus = query(async (): Promise<GitHubStatus> => {
	requireUser();
	return withBackend((b) => b.getGitHubStatus());
});

/**
 * Admin only. Stores a manifest nonce and returns what the page POSTs to
 * GitHub (`postUrl` + hidden `manifest` field). The browser does the POST.
 */
export const beginGitHubAppManifest = command(standard(BeginManifestInput), async (input): Promise<ManifestFormData> => {
	const admin = requireAdmin();
	return withBackend((b) => b.beginGitHubAppManifest(input, admin.login));
});

/** Admin only. Re-sync installations and repositories from GitHub. */
export const refreshGitHubInstallations = command(async (): Promise<InstallationSummary[]> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.refreshGitHubInstallations(admin.login));
	await getGitHubStatus().refresh();
	return result;
});

/** Admin only (ADR 0220): mode → none, app + credentials forgotten. */
export const disconnectGitHub = command(async (): Promise<GitHubStatus> => {
	const admin = requireAdmin();
	const status = await withBackend((b) => b.disconnectGitHub(admin.login));
	await Promise.all([getGitHubStatus().refresh(), getSetupStatus().refresh(), listAuditLog({}).refresh()]);
	return status;
});

/** Admin only. Disabled repos keep receiving webhooks but they are stored as ignored. */
export const setRepoEnabled = command(standard(SetRepoEnabledInput), async (input): Promise<RepoSummary> => {
	const admin = requireAdmin();
	const repo = await withBackend((b) => b.setRepoEnabled(input, admin.login));
	await Promise.all([getGitHubStatus().refresh(), listAuditLog({}).refresh()]);
	return repo;
});
