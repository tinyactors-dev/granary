/**
 * Allowlist management (ADR 0004, ADR 0031). Reading requires a user,
 * mutations require an admin. Mutations refresh `listAllowedUsers` and
 * `getOverview` in the same response (single-flight mutation).
 */
import { command, form, query } from '$app/server';
import { error, invalid } from '@sveltejs/kit';
import { standard } from '$lib/schemas/standard';
import {
	AddAllowedUserInput,
	AdmitAuthorInput,
	SaveAdmittedTemplateInput,
	BLOCK_DURATION_MS,
	BlockUserInput,
	RemoveAllowedUserInput,
	UnblockUserInput,
	type AddAllowedUserResult,
	type AdmitAuthorResult,
	type AdmittedTemplateStatus,
	type AllowedUser,
	type BlockedUser,
	type BlockUserResult,
	type RemoveAllowedUserResult,
	type UnblockUserResult
} from '$lib/schemas/api';
import { requireAdmin, requireUser } from '$lib/server/auth';
import { backendErrorStatus, getBackend, isBackendError } from '$lib/server/backend';
import { withBackend } from '$lib/server/remote-helpers';
import { getOverview } from './dashboard.remote';

/** Sorted by login. */
export const listAllowedUsers = query(async (): Promise<AllowedUser[]> => {
	requireUser();
	return withBackend((b) => b.listAllowedUsers());
});

/**
 * Form `{login, scope?}` (scope empty = everywhere, ADR 0311). Admin only. Idempotent (`added: false` if present).
 * A backend `invalid` error becomes a field issue on `login`.
 */
export const addAllowedUser = form(
	standard(AddAllowedUserInput),
	async ({ login, scope }, issue): Promise<AddAllowedUserResult> => {
		const admin = requireAdmin();
		let result: AddAllowedUserResult;
		try {
			result = await getBackend().addAllowedUser(login, admin.login, scope ?? '');
		} catch (e) {
			if (isBackendError(e) && (e.code === 'invalid' || e.code === 'conflict')) invalid(issue.login(e.message));
			if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
			throw e;
		}
		await Promise.all([listAllowedUsers().refresh(), getOverview().refresh()]);
		return result;
	}
);

// ---------------------------------------------------------------------------
// Blocklist (ADR 0260): beats the allowlist and maintainer associations
// ---------------------------------------------------------------------------

/** Sorted by login; expired entries included (`active: false`). */
export const listBlockedUsers = query(async (): Promise<BlockedUser[]> => {
	requireUser();
	return withBackend((b) => b.listBlockedUsers());
});

/** Form `{login, duration, note?}`. Admin only. Re-blocking replaces note/expiry. */
export const blockUser = form(
	standard(BlockUserInput),
	async ({ login, duration, note }, issue): Promise<BlockUserResult> => {
		const admin = requireAdmin();
		let result: BlockUserResult;
		try {
			result = await getBackend().blockUser({ login, note: note ?? null, forMs: BLOCK_DURATION_MS[duration] }, admin.login);
		} catch (e) {
			if (isBackendError(e) && e.code === 'invalid') invalid(issue.login(e.message));
			if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
			throw e;
		}
		await listBlockedUsers().refresh();
		return result;
	}
);

/** "Block me for 1 hour": the signed-in admin blocks their own login to test the close flow. */
export const blockMe = command(async (): Promise<BlockUserResult> => {
	const admin = requireAdmin();
	const result = await withBackend((b) =>
		b.blockUser({ login: admin.login, note: 'self-test', forMs: BLOCK_DURATION_MS['1h'] }, admin.login)
	);
	await listBlockedUsers().refresh();
	return result;
});

/** Command `{login}`. Admin only. */
export const unblockUser = command(
	standard(UnblockUserInput),
	async ({ login }): Promise<UnblockUserResult> => {
		const admin = requireAdmin();
		const result = await withBackend((b) => b.unblockUser(login, admin.login));
		await listBlockedUsers().refresh();
		return result;
	}
);

/** Command `{login, scope?}` (scope '' = the everywhere entry). Admin only. */
export const removeAllowedUser = command(
	standard(RemoveAllowedUserInput),
	async ({ login, scope }): Promise<RemoveAllowedUserResult> => {
		const admin = requireAdmin();
		const result = await withBackend((b) => b.removeAllowedUser(login, admin.login, scope ?? ''));
		await Promise.all([listAllowedUsers().refresh(), getOverview().refresh()]);
		return result;
	}
);

/**
 * Command `{issueKey, scope}` from Activity (ADR 0313): let the author of an
 * item granary closed in for its repository, its owner or everywhere (lifting
 * an active block) and reopen what was closed on them there. Admin only.
 */
export const admitAuthor = command(
	standard(AdmitAuthorInput),
	async ({ issueKey, scope }): Promise<AdmitAuthorResult> => {
		const admin = requireAdmin();
		const result = await withBackend((b) => b.admitAuthor(issueKey, scope, admin.login));
		await Promise.all([listAllowedUsers().refresh(), listBlockedUsers().refresh(), getOverview().refresh()]);
		return result;
	}
);

/** The comment posted on each item reopened when an admin lets its author in (ADR 0314). */
export const getAdmittedTemplate = query(async (): Promise<AdmittedTemplateStatus> => {
	requireUser();
	return withBackend((b) => b.admittedTemplate());
});

/** Command `{template}` (`null` = the built-in comment). Admin only. */
export const saveAdmittedTemplate = command(standard(SaveAdmittedTemplateInput), async ({ template }): Promise<AdmittedTemplateStatus> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.saveAdmittedTemplate(template, admin.login));
	await getAdmittedTemplate().refresh();
	return result;
});
