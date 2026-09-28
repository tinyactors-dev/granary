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
	RemoveAllowedUserInput,
	type AddAllowedUserResult,
	type AllowedUser,
	type RemoveAllowedUserResult
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
