/**
 * `allowlist/main` (ADR 0002, ADR 0004, ADR 0033, ADR 0260).
 *
 * Spawned once at boot with params `{logins, blocked}` from
 * `allowed_users` / `blocked_users` (lower-cased). One state, `ready`:
 * - `allowlist.check {login, association}` → replies `allowlist.verdict
 *   {login, allowed, reason}` to `_event.origin` (the issue actor), decided by
 *   the shared policy (`../policy.ts`, embedded as chart helpers: blocklist >
 *   allowlist > association);
 * - `allowlist.replace {logins}` swaps the allowlist;
 * - `blocklist.replace {entries}` swaps the blocklist.
 */
import type { Source } from '@tinyactors/node';
import { chart, scxml } from '../../charts';
import { EVENTS, FAMILY, type AllowlistActorData } from '../../schemas/actors';
import { MAINTAINER_ASSOCIATIONS } from '../../schemas/github';
import { blockActive, decidePolicy } from '../policy';

export type { AllowlistActorData };

export function allowlistChart(): Source {
	const initial: AllowlistActorData & { maintainers: string[] } = { logins: [], blocked: [], maintainers: [...MAINTAINER_ASSOCIATIONS] };
	return chart({
		name: FAMILY.allowlist,
		initial: 'ready',
		helpers: { blockActive, decidePolicy },
		data: initial,
		body: scxml`
<state id="ready">
	<transition event="${EVENTS.allowlistCheck}">
		<send event="${EVENTS.allowlistVerdict}" targetexpr="_event.origin">
			<content expr="decidePolicy({ allowed: logins, blocked }, _event.data, Date.now(), maintainers)"/>
		</send>
	</transition>
	<transition event="${EVENTS.allowlistReplace}">
		<assign location="logins" expr="_event.data.logins.map((l) => l.toLowerCase())"/>
	</transition>
	<transition event="${EVENTS.blocklistReplace}">
		<assign location="blocked" expr="${'_event.data.entries.map((e) => ({ login: e.login.toLowerCase(), expiresAt: e.expiresAt }))'}"/>
	</transition>
</state>`
	});
}
