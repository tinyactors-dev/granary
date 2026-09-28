/**
 * `allowlist/main` (ADR 0002, ADR 0004, ADR 0033).
 *
 * Spawned once at boot with binding `{logins}` from `allowed_users`
 * (lower-cased). One state, `ready`:
 * - `allowlist.check {login, association}` → replies `allowlist.verdict
 *   {login, allowed, reason}` to `event.origin` (the issue actor);
 * - `allowlist.replace {logins}` swaps the whole set.
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import {
	EVENTS,
	FAMILY,
	type AllowlistActorData,
	type AllowlistCheckData,
	type AllowlistReplaceData,
	type AllowlistVerdictData
} from '../../schemas/actors';
import { MAINTAINER_ASSOCIATIONS } from '../../schemas/github';

export type { AllowlistActorData };

export const ALLOWLIST_REVISION = 'v1';

/** The policy of ADR 0004: allowlist (case-insensitive) or maintainer association. */
export function decide(logins: readonly string[], check: AllowlistCheckData): AllowlistVerdictData {
	const login = check.login;
	if (logins.includes(login.toLowerCase())) return { login, allowed: true, reason: 'allowlist' };
	if (MAINTAINER_ASSOCIATIONS.includes(check.association)) return { login, allowed: true, reason: 'association' };
	return { login, allowed: false, reason: 'not-allowed' };
}

type Ctx = EvaluationContext<AllowlistActorData>;

export function allowlistChart(): DefinitionBuilder<AllowlistActorData> {
	return statechart<AllowlistActorData>({ family: FAMILY.allowlist, revision: ALLOWLIST_REVISION, name: 'allowlist' })
		.data('logins', [])
		.initial('ready')
		.state('ready', (s) =>
			s
				.on(EVENTS.allowlistCheck, (t) =>
					t.send(EVENTS.allowlistVerdict, (b) =>
						b
							.to(({ event }: Ctx) => String(event?.origin ?? ''))
							.data(({ data, event }: Ctx) => decide(data.logins, event!.data as AllowlistCheckData))
					)
				)
				.on(EVENTS.allowlistReplace, (t) =>
					t.assign('logins', ({ event }: Ctx) =>
						(event!.data as AllowlistReplaceData).logins.map((l) => l.toLowerCase())
					)
				)
		);
}
