/**
 * `allowlist/main` (ADR 0002, ADR 0004, ADR 0033, ADR 0260).
 *
 * Spawned once at boot with binding `{logins, blocked}` from
 * `allowed_users` / `blocked_users` (lower-cased). One state, `ready`:
 * - `allowlist.check {login, association}` → replies `allowlist.verdict
 *   {login, allowed, reason}` to `event.origin` (the issue actor), decided by
 *   the shared policy (`../policy.ts`: blocklist > allowlist > association);
 * - `allowlist.replace {logins}` swaps the allowlist;
 * - `blocklist.replace {entries}` swaps the blocklist.
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import {
	EVENTS,
	FAMILY,
	type AllowlistActorData,
	type AllowlistCheckData,
	type AllowlistReplaceData,
	type AllowlistVerdictData,
	type BlockEntry,
	type BlocklistReplaceData
} from '../../schemas/actors';
import { decidePolicy } from '../policy';

export type { AllowlistActorData };

export const ALLOWLIST_REVISION = 'v2';

/** The policy of ADR 0004 / 0260 for one check (see `../policy.ts`). */
export function decide(
	logins: readonly string[],
	check: AllowlistCheckData,
	blocked: readonly BlockEntry[] = [],
	now: number = Date.now()
): AllowlistVerdictData {
	return decidePolicy({ allowed: logins, blocked }, check, now);
}

type Ctx = EvaluationContext<AllowlistActorData>;

export function allowlistChart(): DefinitionBuilder<AllowlistActorData> {
	return statechart<AllowlistActorData>({ family: FAMILY.allowlist, revision: ALLOWLIST_REVISION, name: 'allowlist' })
		.data('logins', [])
		.data('blocked', [])
		.initial('ready')
		.state('ready', (s) =>
			s
				.on(EVENTS.allowlistCheck, (t) =>
					t.send(EVENTS.allowlistVerdict, (b) =>
						b
							.to(({ event }: Ctx) => String(event?.origin ?? ''))
							.data(({ data, event }: Ctx) => decide(data.logins, event!.data as AllowlistCheckData, data.blocked))
					)
				)
				.on(EVENTS.allowlistReplace, (t) =>
					t.assign('logins', ({ event }: Ctx) =>
						(event!.data as AllowlistReplaceData).logins.map((l) => l.toLowerCase())
					)
				)
				.on(EVENTS.blocklistReplace, (t) =>
					t.assign('blocked', ({ event }: Ctx) =>
						(event!.data as BlocklistReplaceData).entries.map((e) => ({ login: e.login.toLowerCase(), expiresAt: e.expiresAt }))
					)
				)
		);
}
