/**
 * Who may open an issue or a pull request (ADR 0004, ADR 0260).
 *
 * Kind-agnostic: the subject is just an author login plus its
 * `author_association`, so issues and pull requests share one policy.
 * Precedence, first match wins:
 *   1. `blocklist`   — an active blocked_users entry (beats everything,
 *                      including admins/owners: that is how an owner tests
 *                      the close flow end to end);
 *   2. `allowlist`   — login in allowed_users (case-insensitive);
 *   3. `association` — OWNER / MEMBER / COLLABORATOR;
 *   4. `not-allowed` — none of these.
 * A blocklist entry with `expiresAt <= now` is inactive (expiry needs no
 * timer: it is evaluated at decision time).
 */
import type { AllowlistVerdictData, BlockEntry } from '../schemas/actors';
import { MAINTAINER_ASSOCIATIONS, type AuthorAssociation } from '../schemas/github';

export interface PolicySubject {
	login: string;
	association: AuthorAssociation;
}

export interface PolicyLists {
	/** Lower-cased allowlisted logins. */
	allowed: readonly string[];
	/** Blocklist entries (logins lower-cased). */
	blocked: readonly BlockEntry[];
}

/** Is this blocklist entry in force at `now`? */
export const blockActive = (e: BlockEntry, now: number): boolean => e.expiresAt === null || e.expiresAt > now;

export function decidePolicy(lists: PolicyLists, subject: PolicySubject, now: number = Date.now()): AllowlistVerdictData {
	const login = subject.login;
	const lower = login.toLowerCase();
	if (lists.blocked.some((e) => e.login === lower && blockActive(e, now))) return { login, allowed: false, reason: 'blocklist' };
	if (lists.allowed.includes(lower)) return { login, allowed: true, reason: 'allowlist' };
	if (MAINTAINER_ASSOCIATIONS.includes(subject.association)) return { login, allowed: true, reason: 'association' };
	return { login, allowed: false, reason: 'not-allowed' };
}
