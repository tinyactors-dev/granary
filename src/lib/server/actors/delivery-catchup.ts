/**
 * `delivery-catchup/main` (ADR 0162, 0194): asks GitHub to redeliver
 * webhooks granary missed (downtime, deploys, setup). App mode only.
 *
 * idle ──tick / run-now──▶ listing ──listed (candidates)──▶ redelivering ──▶ idle
 *                            └──listed (none) / failed──▶ idle
 *
 * `idle` arms a delayed `catchup.tick`: `firstDelayMs` after boot, then
 * `intervalMs`. All GitHub I/O goes through the `github-app` processor.
 */
import type { Source } from '@tinyactors/node';
import { chart, scxml } from '../../charts';
import { CATCHUP_EVENTS, CATCHUP_FAMILY, CATCHUP_IO_TYPE, type CatchupCandidate } from '../github/catchup';

export const CATCHUP_FIRST_DELAY_MS = 30_000;
export const CATCHUP_INTERVAL_MS = 10 * 60_000;
const TICK_ID = 'tick';

export interface DeliveryCatchupData {
	firstDelayMs: number;
	intervalMs: number;
	/** true until the first tick fired. */
	first: boolean;
	candidates: CatchupCandidate[];
	newest: number | null;
	passes: number;
	lastRedelivered: number;
	lastError: string | null;
}

export function deliveryCatchupChart(): Source {
	const E = CATCHUP_EVENTS;
	const initial: DeliveryCatchupData = {
		firstDelayMs: CATCHUP_FIRST_DELAY_MS,
		intervalMs: CATCHUP_INTERVAL_MS,
		first: true,
		candidates: [],
		newest: null,
		passes: 0,
		lastRedelivered: 0,
		lastError: null
	};
	return chart({
		name: CATCHUP_FAMILY,
		initial: 'idle',
		data: initial,
		body: scxml`
<state id="idle">
	<onentry><send id="${TICK_ID}" event="${E.tick}" delayexpr="(first ? firstDelayMs : intervalMs) + 'ms'"/></onentry>
	<onexit>
		<cancel sendid="${TICK_ID}"/>
		<assign location="first" expr="false"/>
	</onexit>
	<transition event="${E.tick}" target="listing"/>
	<transition event="${E.runNow}" target="listing"/>
</state>

<state id="listing">
	<onentry><send type="${CATCHUP_IO_TYPE}" event="${E.list}"/></onentry>
	<transition event="${E.listed}" cond="_event.data.candidates.length > 0" target="redelivering">
		<assign location="candidates" expr="_event.data.candidates"/>
		<assign location="newest" expr="_event.data.newest"/>
	</transition>
	<transition event="${E.listed}" target="idle">
		<assign location="passes" expr="passes + 1"/>
		<assign location="lastRedelivered" expr="0"/>
		<assign location="lastError" expr="null"/>
	</transition>
	<transition event="${E.failed}" target="idle">
		<assign location="passes" expr="passes + 1"/>
		<assign location="lastError" expr="_event.data.error"/>
	</transition>
	<transition event="error.communication" target="idle">
		<assign location="lastError" expr="'github-app processor failed'"/>
	</transition>
</state>

<state id="redelivering">
	<onentry>
		<send type="${CATCHUP_IO_TYPE}" event="${E.redeliver}"><content expr="({ ids: candidates.map((c) => c.id), newest })"/></send>
	</onentry>
	<transition event="${E.redelivered}" target="idle">
		<assign location="passes" expr="passes + 1"/>
		<assign location="candidates" expr="[]"/>
		<assign location="lastRedelivered" expr="_event.data.redelivered"/>
		<assign location="lastError" expr="_event.data.lastError"/>
	</transition>
	<transition event="${E.failed}" target="idle">
		<assign location="passes" expr="passes + 1"/>
		<assign location="candidates" expr="[]"/>
		<assign location="lastError" expr="_event.data.error"/>
	</transition>
	<transition event="error.communication" target="idle">
		<assign location="candidates" expr="[]"/>
		<assign location="lastError" expr="'github-app processor failed'"/>
	</transition>
</state>`
	});
}
