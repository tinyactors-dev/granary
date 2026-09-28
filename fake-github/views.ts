/** GitHub-shaped views the host builds from registry data (ADR 0006, ADR 0060). */
import type { FakeRepo, FakeUser } from './schemas';
import type { GitHubUser, Issue, IssuesWebhookPayload, Repository } from '../src/lib/schemas/github';

export interface Bases {
	web: string;
	api: string;
}

export function userView(u: FakeUser, bases: Bases): GitHubUser & Record<string, unknown> {
	return {
		login: u.login,
		id: u.id,
		node_id: `U_fake${u.id}`,
		type: u.type,
		site_admin: false,
		avatar_url: u.avatarUrl,
		html_url: `${bases.web}/${u.login}`,
		url: `${bases.api}/users/${u.login}`
	};
}

export function repositoryView(r: FakeRepo, owner: FakeUser, bases: Bases): Repository & Record<string, unknown> {
	return {
		id: r.id,
		node_id: `R_fake${r.id}`,
		name: r.name,
		full_name: r.fullName,
		private: false,
		owner: userView(owner, bases),
		html_url: `${bases.web}/${r.fullName}`,
		url: `${bases.api}/repos/${r.fullName}`,
		default_branch: 'main'
	};
}

/** A realistic `issues` event body. */
export function issuesEvent(
	action: string,
	issue: Issue,
	repository: Repository,
	sender: GitHubUser
): IssuesWebhookPayload {
	return { action, issue, repository, sender };
}
