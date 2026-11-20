/**
 * `registry/main` — the fake GitHub's users and repositories (ADR 0060).
 *
 * Ids are allocated by the host (`fake-github/ids.ts`) and passed in as
 * `newId`/`newRepoId`/`newOwnerId`; the registry uses them only when it
 * creates something. Logins are keyed case-insensitively.
 */
import { handlerChart } from '../../src/lib/charts';
import type { FakeRepo, FakeUser } from '../schemas';
import type { UserType } from '../../src/lib/schemas/github';

export const REGISTRY_ADDRESS = 'registry/main';
export const REGISTRY_CHART = 'registry';

export interface RegistryData {
	users: Record<string, FakeUser>;
	repos: Record<string, FakeRepo>;
}

export const REGISTRY_EVENTS = {
	ensureUser: 'user.ensure',
	getUser: 'user.get',
	ensureRepo: 'repo.ensure',
	findRepo: 'repo.find'
} as const;

export interface EnsureUserEvent {
	login: string;
	type?: UserType;
	newId: number;
}
export interface EnsureRepoEvent {
	owner: string;
	name: string;
	newRepoId: number;
	newOwnerId: number;
}
export interface EnsureRepoResult {
	repo: FakeRepo;
	owner: FakeUser;
	created: boolean;
}

/** Embedded as a chart helper: self-contained. */
function ensureUser(d: RegistryData, login: string, newId: number, type?: UserType): FakeUser {
	const key = login.toLowerCase();
	const existing = d.users[key];
	if (existing) {
		if (type && existing.type !== type) existing.type = type;
		return { ...existing };
	}
	const user: FakeUser = {
		login,
		id: newId,
		type: type ?? (login.endsWith('[bot]') ? 'Bot' : 'User'),
		avatarUrl: `https://avatars.githubusercontent.com/u/${newId}?v=4`
	};
	d.users[key] = user;
	return { ...user };
}

export const registryChart = handlerChart<RegistryData>({
	name: REGISTRY_CHART,
	initial: { users: {}, repos: {} },
	helpers: { ensureUser },
	handlers: {
		[REGISTRY_EVENTS.ensureUser]: (d, e: EnsureUserEvent) => ensureUser(d, e.login, e.newId, e.type),
		[REGISTRY_EVENTS.getUser]: (d, e: { login: string }) => {
			const u = d.users[e.login.toLowerCase()];
			return u ? { ...u } : null;
		},
		[REGISTRY_EVENTS.ensureRepo]: (d, e: EnsureRepoEvent): EnsureRepoResult => {
			const owner = ensureUser(d, e.owner, e.newOwnerId);
			const key = `${e.owner}/${e.name}`.toLowerCase();
			const existing = d.repos[key];
			if (existing) return { repo: { ...existing }, owner, created: false };
			const repo: FakeRepo = { id: e.newRepoId, owner: owner.login, name: e.name, fullName: `${owner.login}/${e.name}` };
			d.repos[key] = repo;
			return { repo: { ...repo }, owner, created: true };
		},
		[REGISTRY_EVENTS.findRepo]: (d, e: { owner: string; name: string }) => {
			const r = d.repos[`${e.owner}/${e.name}`.toLowerCase()];
			return r ? { ...r } : null;
		}
	}
});
