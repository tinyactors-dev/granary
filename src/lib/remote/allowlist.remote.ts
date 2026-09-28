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
	BLOCK_DURATION_MS,
	BlockUserInput,
	RemoveAllowedUserInput,
	UnblockUserInput,
	type AddAllowedUserResult,
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
 * Form with one field, `login`. Admin only. Idempotent (`added: false` if present).
 * A backend `invalid` error becomes a field issue on `login`.
 */
export const addAllowedUser = form(
	standard(AddAllowedUserInput),
	async ({ login }, issue): Promise<AddAllowedUserResult> => {
		const admin = requireAdmin();
		let result: AddAllowedUserResult;
		try {
			result = await getBackend().addAllowedUser(login, admin.login);
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

/** Command `{login}`. Admin only. */
export const removeAllowedUser = command(
	standard(RemoveAllowedUserInput),
	async ({ login }): Promise<RemoveAllowedUserResult> => {
		const admin = requireAdmin();
		const result = await withBackend((b) => b.removeAllowedUser(login, admin.login));
		await Promise.all([listAllowedUsers().refresh(), getOverview().refresh()]);
		return result;
	}
);
