/**
 * Introductions through GitHub Discussions (ADR 0310), the parts that are
 * neither the actor nor the relay: which discussions count, their scope, the
 * settings (each owner's org discussions repository, the approval reply),
 * the "Introduce yourself" link for closing messages, and the per-repository
 * setup check. No SvelteKit imports.
 */
import type { Database } from 'bun:sqlite';
import { check } from '../schemas/standard';
import { Type } from '@sinclair/typebox';
import {
	APPROVED_MESSAGE_SETTING,
	DEFAULT_APPROVED_TEMPLATE,
	renderApproved,
	validateApprovedTemplate,
	type ApprovedContext
} from '../schemas/message-template';
import type { DiscussionCategory } from '../schemas/github';
import type { DiscussionSetupState } from '../schemas/wal';
import { DISCUSSIONS_PERMISSION } from '../schemas/github-app';
import { AdminStore, AdminStoreError } from './admins';
import { GitHubGraphQLError, type GitHubClient } from './github-client';
import { log } from './log';
import type { Wal } from './wal';
import type { DiscussionSetupRow } from '../schemas/wal';
import { installationDiscussionAccess, type GitHubConnection } from './github/connection';

/** The category people introduce themselves in: this slug, or this name in any case. */
export const INTRODUCTIONS_CATEGORY = { name: 'Introductions', slug: 'introductions', emoji: ':wave:' } as const;
/** What the setup steps suggest for the category's description. */
export const INTRODUCTIONS_CATEGORY_DESCRIPTION = 'Say hello: who you are and what you would like to work on. A maintainer reads every introduction.';
/** The org discussions repository when an owner names none (GitHub's convention). */
export const DEFAULT_ORG_REPOSITORY = '.github';
/** Setting: `{ "<owner lower-cased>": "<repo>" }`. */
export const ORG_REPOSITORIES_SETTING = 'introductions.orgRepositories';

const OrgRepositories = Type.Record(Type.String(), Type.String({ pattern: '^[A-Za-z0-9_.-]{1,100}$' }));

export function isIntroductionsCategory(c: Pick<DiscussionCategory, 'slug' | 'name'> | null | undefined): boolean {
	if (!c) return false;
	return c.slug.toLowerCase() === INTRODUCTIONS_CATEGORY.slug || c.name.trim().toLowerCase() === INTRODUCTIONS_CATEGORY.name.toLowerCase();
}

// -- settings ------------------------------------------------------------------------------

export function readOrgRepositories(db: Database): Record<string, string> {
	const s = new AdminStore(db).getSetting(ORG_REPOSITORIES_SETTING);
	return s && check(OrgRepositories, s.value) ? s.value : {};
}

/** The org discussions repository's name for an owner. */
export function orgRepositoryOf(db: Database, owner: string): string {
	return readOrgRepositories(db)[owner.toLowerCase()] ?? DEFAULT_ORG_REPOSITORY;
}

/** Name an owner's org discussions repository (`null` = back to `.github`). */
export function setOrgRepository(db: Database, owner: string, repo: string | null, by: string): Record<string, string> {
	if (repo !== null && !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new AdminStoreError('invalid', 'Not a valid repository name');
	const next = { ...readOrgRepositories(db) };
	if (repo === null) delete next[owner.toLowerCase()];
	else next[owner.toLowerCase()] = repo;
	new AdminStore(db).setSetting(ORG_REPOSITORIES_SETTING, next, 'ui', by, { action: 'config.set', details: { key: ORG_REPOSITORIES_SETTING, owner, repo } });
	return next;
}

/** The approval reply's template: the stored one, or the built-in default. */
export function readApprovedTemplate(db: Database): { template: string; custom: boolean } {
	const s = new AdminStore(db).getSetting(APPROVED_MESSAGE_SETTING);
	if (s && typeof s.value === 'string' && validateApprovedTemplate(s.value).length === 0) return { template: s.value, custom: true };
	return { template: DEFAULT_APPROVED_TEMPLATE, custom: false };
}

/** Save the approval reply's template (`null` = back to the default); throws AdminStoreError('invalid'). */
export function saveApprovedTemplate(db: Database, template: string | null, by: string): { template: string; custom: boolean } {
	if (template !== null) {
		const problems = validateApprovedTemplate(template);
		if (problems.length) throw new AdminStoreError('invalid', problems.map((p) => p.message).join('; '));
	}
	new AdminStore(db).setSetting(APPROVED_MESSAGE_SETTING, template, 'ui', by, { action: 'config.set', details: { key: APPROVED_MESSAGE_SETTING, custom: template !== null } });
	return readApprovedTemplate(db);
}

/** The approval reply, from the template in effect now; falls back to the default if it fails. */
export function renderApprovedReply(db: Database, ctx: ApprovedContext): string {
	const { template } = readApprovedTemplate(db);
	try {
		return renderApproved(template, ctx);
	} catch (e) {
		log.warn(`introductions: the approval reply template failed to render (${(e as Error).message}); using the default`);
		return renderApproved(DEFAULT_APPROVED_TEMPLATE, ctx);
	}
}

// -- scope and link -----------------------------------------------------------------------

/**
 * What an introduction in `owner/repo` is about: the owner's repositories
 * when it is the owner's org discussions repository, the repository when
 * issue gating is on there, else nothing (not an introduction granary acts on).
 */
export function introductionScope(db: Database, owner: string, repo: string, guarded: boolean): string | null {
	if (orgRepositoryOf(db, owner).toLowerCase() === repo.toLowerCase()) return owner.toLowerCase();
	return guarded ? `${owner}/${repo}`.toLowerCase() : null;
}

/** Where someone closed in `owner/repo` introduces themselves: that repository's category, else the owner's; '' when neither is ready. */
export function introduceUrlFor(db: Database, owner: string, repo: string): string {
	const ready = (fullName: string) =>
		(db.query(`SELECT new_url FROM discussion_setup WHERE full_name = ?1 AND state = 'ready'`).get(fullName.toLowerCase()) as { new_url: string | null } | null)?.new_url ?? null;
	return ready(`${owner}/${repo}`) ?? ready(`${owner}/${orgRepositoryOf(db, owner)}`) ?? '';
}

// -- setup check ------------------------------------------------------------------------------

export interface SetupTarget {
	owner: string;
	repo: string;
	repoId: number | null;
	/** The owner's org discussions repository (links go to the org's discussions). */
	org: boolean;
	/** The owner is an organization (only they have org-level discussions on GitHub). */
	ownerIsOrganization: boolean;
	/** The installation accepted `discussions` (null = unknown installation). */
	access: boolean | null;
}

export interface SetupResult {
	state: DiscussionSetupState;
	categoryId: string | null;
	categorySlug: string | null;
	newUrl: string | null;
	error: string | null;
}

/** Check one repository with GraphQL and record the result. Never throws. */
export async function checkDiscussionSetup(wal: Wal, target: SetupTarget, client: () => Promise<GitHubClient>, webUrl: string): Promise<SetupResult> {
	const fullName = `${target.owner}/${target.repo}`;
	let result: SetupResult;
	if (target.access === false) {
		result = { state: 'no-access', categoryId: null, categorySlug: null, newUrl: null, error: `the installation has not accepted the ${DISCUSSIONS_PERMISSION} permission` };
	} else {
		try {
			const r = await (await client()).discussionSetup(target.owner, target.repo);
			if (!r.repository) result = { state: 'missing', categoryId: null, categorySlug: null, newUrl: null, error: null };
			else if (!r.repository.hasDiscussionsEnabled) result = { state: 'disabled', categoryId: null, categorySlug: null, newUrl: null, error: null };
			else {
				const cat = (r.repository.discussionCategories?.nodes ?? []).find((c) => c !== null && isIntroductionsCategory(c)) ?? null;
				if (!cat) result = { state: 'no-category', categoryId: null, categorySlug: null, newUrl: null, error: null };
				else {
					const web = webUrl.replace(/\/+$/, '');
					const base = target.org && target.ownerIsOrganization ? `${web}/orgs/${encodeURIComponent(target.owner)}` : `${web}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
					result = { state: 'ready', categoryId: cat.id, categorySlug: cat.slug, newUrl: `${base}/discussions/new?category=${encodeURIComponent(cat.slug)}`, error: null };
				}
			}
		} catch (e) {
			if (e instanceof GitHubGraphQLError && e.types.includes('NOT_FOUND')) result = { state: 'missing', categoryId: null, categorySlug: null, newUrl: null, error: null };
			else if (e instanceof GitHubGraphQLError && e.types.includes('FORBIDDEN')) result = { state: 'no-access', categoryId: null, categorySlug: null, newUrl: null, error: e.message };
			else result = { state: 'error', categoryId: null, categorySlug: null, newUrl: null, error: (e as Error).message.slice(0, 300) };
		}
	}
	wal.setDiscussionSetup({ fullName, repoId: target.repoId, ...result });
	log.info(`introductions: ${fullName} setup ${result.state}${result.error ? ` (${result.error})` : ''}`, { 'github.repository': fullName, 'introductions.setup': result.state });
	return result;
}

/** One repository granary expects introductions in, with its last check. */
export interface SetupEntry {
	target: SetupTarget;
	installationId: number;
	check: DiscussionSetupRow | null;
}

/**
 * The repositories introductions can come from (every gated repository, and
 * each installation account's org discussions repository) and their checks.
 */
export class IntroductionSetup {
	readonly #wal: Wal;
	readonly #github: GitHubConnection;
	readonly #webUrl: string;
	#running: Promise<void> | null = null;
	#next: Promise<void> | null = null;

	constructor(deps: { wal: Wal; github: GitHubConnection; webUrl: string }) {
		this.#wal = deps.wal;
		this.#github = deps.github;
		this.#webUrl = deps.webUrl;
	}

	entries(): SetupEntry[] {
		const store = this.#github.store;
		const installations = store.listInstallations().filter((i) => !i.suspended);
		const byId = new Map(installations.map((i) => [i.installation_id, i]));
		const out = new Map<string, SetupEntry>();
		for (const r of store.listRepos()) {
			const inst = r.installation_id !== null ? byId.get(r.installation_id) : undefined;
			if (!inst || !r.enabled) continue;
			const [owner, repo] = r.full_name.split('/') as [string, string];
			const org = orgRepositoryOf(this.#wal.db, owner).toLowerCase() === repo.toLowerCase();
			out.set(r.full_name.toLowerCase(), {
				target: { owner, repo, repoId: r.repo_id, org, ownerIsOrganization: inst.account_type === 'Organization', access: installationDiscussionAccess(inst) },
				installationId: inst.installation_id,
				check: this.#wal.getDiscussionSetup(r.full_name)
			});
		}
		for (const inst of installations) {
			const owner = inst.account_login;
			const repo = orgRepositoryOf(this.#wal.db, owner);
			const key = `${owner}/${repo}`.toLowerCase();
			const known = out.get(key);
			if (known) {
				known.target.org = true;
				continue;
			}
			const row = store.listRepos().find((r) => r.full_name.toLowerCase() === key);
			out.set(key, {
				target: { owner, repo, repoId: row?.repo_id ?? null, org: true, ownerIsOrganization: inst.account_type === 'Organization', access: installationDiscussionAccess(inst) },
				installationId: inst.installation_id,
				check: this.#wal.getDiscussionSetup(key)
			});
		}
		return [...out.values()].sort((a, b) => `${a.target.owner}/${a.target.repo}`.localeCompare(`${b.target.owner}/${b.target.repo}`));
	}

	/** Check one repository (by `owner/repo`); null when it is not one introductions come from. */
	async check(owner: string, repo: string): Promise<SetupResult | null> {
		if (this.#github.mode() !== 'app') return null;
		const e = this.entries().find((x) => `${x.target.owner}/${x.target.repo}`.toLowerCase() === `${owner}/${repo}`.toLowerCase());
		if (!e) return null;
		return checkDiscussionSetup(this.#wal, e.target, async () => this.#github.clientForInstallation(e.installationId), this.#webUrl);
	}

	/**
	 * Check every repository, one at a time. A call while a run is going waits
	 * for it and then runs again (what changed meanwhile is seen); calls that
	 * pile up meanwhile share that second run.
	 */
	checkAll(): Promise<void> {
		if (this.#next) return this.#next;
		const after = (this.#running ?? Promise.resolve()).catch(() => undefined);
		const run: Promise<void> = after.then(async () => {
			if (this.#next === run) this.#next = null;
			this.#running = run;
			try {
				if (this.#github.mode() !== 'app') return;
				for (const e of this.entries()) {
					await checkDiscussionSetup(this.#wal, e.target, async () => this.#github.clientForInstallation(e.installationId), this.#webUrl);
				}
			} finally {
				if (this.#running === run) this.#running = null;
			}
		});
		this.#next = run;
		return run;
	}
}
