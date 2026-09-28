/**
 * `registry/main` — the fake GitHub's users and repositories (ADR 0060).
 *
 * Ids are allocated by the host (`fake-github/ids.ts`) and passed in as
 * `newId`/`newRepoId`/`newOwnerId`; the registry uses them only when it
 * creates something. Logins are keyed case-insensitively.
 */
import { statechart } from '@tinyactors/node';
import type { FakeRepo, FakeUser } from '../schemas';
import type { UserType } from '../../src/lib/schemas/github';
import { answer } from '../io/reply';

export const REGISTRY_ADDRESS = { family: 'registry', name: 'main' } as const;

export interface RegistryData {
	users: Record<string, FakeUser>;
	repos: Record<string, FakeRepo>;
	out: unknown;
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

export const avatarUrl = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

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
		avatarUrl: avatarUrl(newId)
	};
	d.users[key] = user;
	return { ...user };
}

export const registryChart = statechart<RegistryData>({ family: 'registry', revision: 'v1' })
	.dataExpression('users', () => ({}))
	.dataExpression('repos', () => ({}))
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				REGISTRY_EVENTS.ensureUser,
				answer<RegistryData, EnsureUserEvent>((d, e) => ensureUser(d, e.login, e.newId, e.type))
			)
			.on(
				REGISTRY_EVENTS.getUser,
				answer<RegistryData, { login: string }>((d, e) => {
					const u = d.users[e.login.toLowerCase()];
					return u ? { ...u } : null;
				})
			)
			.on(
				REGISTRY_EVENTS.ensureRepo,
				answer<RegistryData, EnsureRepoEvent>((d, e): EnsureRepoResult => {
					const owner = ensureUser(d, e.owner, e.newOwnerId);
					const key = `${e.owner}/${e.name}`.toLowerCase();
					const existing = d.repos[key];
					if (existing) return { repo: { ...existing }, owner, created: false };
					const repo: FakeRepo = {
						id: e.newRepoId,
						owner: owner.login,
						name: e.name,
						fullName: `${owner.login}/${e.name}`
					};
					d.repos[key] = repo;
					return { repo: { ...repo }, owner, created: true };
				})
			)
			.on(
				REGISTRY_EVENTS.findRepo,
				answer<RegistryData, { owner: string; name: string }>((d, e) => {
					const r = d.repos[`${e.owner}/${e.name}`.toLowerCase()];
					return r ? { ...r } : null;
				})
			)
	);
