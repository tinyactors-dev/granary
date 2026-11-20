/**
 * Who may open an issue or a pull request (ADR 0004, ADR 0260).
 *
 * Kind-agnostic: the subject is just an author login plus its
 * `author_association`, so issues and pull requests share one policy.
 * Precedence, first match wins:
 *   1. `blocklist`   — an active blocked_users entry (beats everything,
 *                      including admins/owners: that is how an owner tests
 *                      the close flow end to end);
 *   2. `allowlist`   — an allowed_users entry for the login whose scope is
 *                      everywhere, the item's owner or the item's
 *                      repository (case-insensitive, ADR 0311);
 *   3. `association` — OWNER / MEMBER / COLLABORATOR;
 *   4. `not-allowed` — none of these.
 * A blocklist entry with `expiresAt <= now` is inactive (expiry needs no
 * timer: it is evaluated at decision time).
 */
import type { AllowEntry, AllowlistVerdictData, BlockEntry } from '../schemas/actors';
import { MAINTAINER_ASSOCIATIONS, type AuthorAssociation } from '../schemas/github';

export interface PolicySubject {
	login: string;
	association: AuthorAssociation;
	/** Where the item is (ADR 0311). */
	owner: string;
	repo: string;
}

export interface PolicyLists {
	/** Allowlist entries, lower-cased (ADR 0311). */
	allowed: readonly AllowEntry[];
	/** Blocklist entries (logins lower-cased). */
	blocked: readonly BlockEntry[];
}

/** Does an allowlist entry's scope cover `owner/repo`? `''` = everywhere (ADR 0311). */
export function scopeCovers(scope: string, owner: string, repo: string): boolean {
	if (scope === '') return true;
	const o = owner.toLowerCase();
	return scope === o || scope === `${o}/${repo.toLowerCase()}`;
}

/** Is this blocklist entry in force at `now`? */
export function blockActive(e: BlockEntry, now: number): boolean {
	return e.expiresAt === null || e.expiresAt > now;
}

/**
 * The decision for one subject. The allowlist actor's chart embeds this
 * function, `scopeCovers` and `blockActive` as helpers (ADR 0300), so all must stay
 * self-contained: the chart passes `maintainers` and `now` explicitly.
 */
export function decidePolicy(
	lists: PolicyLists,
	subject: PolicySubject,
	now: number = Date.now(),
	maintainers: readonly string[] = MAINTAINER_ASSOCIATIONS
): AllowlistVerdictData {
	const login = subject.login;
	const lower = login.toLowerCase();
	if (lists.blocked.some((e) => e.login === lower && blockActive(e, now))) return { login, allowed: false, reason: 'blocklist' };
	if (lists.allowed.some((e) => e.login === lower && scopeCovers(e.scope, subject.owner, subject.repo))) return { login, allowed: true, reason: 'allowlist' };
	if (maintainers.includes(subject.association)) return { login, allowed: true, reason: 'association' };
	return { login, allowed: false, reason: 'not-allowed' };
}
