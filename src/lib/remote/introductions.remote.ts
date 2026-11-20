/**
 * Introductions (ADR 0310, ADR 0031): reading requires a user, decisions
 * and setup changes require an admin. Decisions refresh the list and counts
 * in the same response.
 */
import { command, query } from '$app/server';
import { standard } from '$lib/schemas/standard';
import {
	DeclineIntroductionInput,
	IntroductionKeyInput,
	ListIntroductionsInput,
	SaveApprovedTemplateInput,
	SetOrgRepositoryInput,
	type IntroductionCounts,
	type IntroductionSetupStatus,
	type IntroductionSummary
} from '$lib/schemas/api';
import { requireAdmin, requireUser } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Newest first; `state` filters (at most 200). */
export const listIntroductions = query(standard(ListIntroductionsInput), async (input): Promise<IntroductionSummary[]> => {
	requireUser();
	return withBackend((b) => b.listIntroductions(input));
});

export const getIntroductionCounts = query(async (): Promise<IntroductionCounts> => {
	requireUser();
	return withBackend((b) => b.introductionCounts());
});

/** Where introductions come from and what each repository still needs. */
export const getIntroductionSetup = query(async (): Promise<IntroductionSetupStatus> => {
	requireUser();
	return withBackend((b) => b.introductionSetup());
});

/** Approve: allowlist them for the scope, reopen what was closed on them, reply on the discussion. Admin only. */
export const approveIntroduction = command(standard(IntroductionKeyInput), async ({ introKey }): Promise<IntroductionSummary> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.approveIntroduction(introKey, admin.login));
	await getIntroductionCounts().refresh();
	return result;
});

/** Decline: recorded in granary only; nothing is posted on GitHub. Admin only. */
export const declineIntroduction = command(standard(DeclineIntroductionInput), async ({ introKey, note }): Promise<IntroductionSummary> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.declineIntroduction(introKey, admin.login, note?.trim() ? note.trim() : null));
	await getIntroductionCounts().refresh();
	return result;
});

/** Check every repository's Discussions again. Admin only. */
export const checkIntroductionSetup = command(async (): Promise<IntroductionSetupStatus> => {
	requireAdmin();
	const result = await withBackend((b) => b.checkIntroductionSetup());
	await getIntroductionSetup().refresh();
	return result;
});

/** Name an owner's org discussions repository (`repo: null` = `.github`). Admin only. */
export const setOrgRepository = command(standard(SetOrgRepositoryInput), async ({ owner, repo }): Promise<IntroductionSetupStatus> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.setOrgRepository(owner, repo, admin.login));
	await getIntroductionSetup().refresh();
	return result;
});

/** The reply posted on an approved introduction (`template: null` = the built-in one). Admin only. */
export const saveApprovedTemplate = command(standard(SaveApprovedTemplateInput), async ({ template }): Promise<IntroductionSetupStatus> => {
	const admin = requireAdmin();
	const result = await withBackend((b) => b.saveApprovedTemplate(template, admin.login));
	await getIntroductionSetup().refresh();
	return result;
});
