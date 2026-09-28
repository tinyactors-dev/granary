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
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import {
	CATCHUP_EVENTS,
	CATCHUP_FAMILY,
	CATCHUP_IO_TYPE,
	type CatchupCandidate,
	type CatchupFailed,
	type CatchupListed,
	type CatchupRedeliver,
	type CatchupRedelivered
} from '../github/catchup';

export const CATCHUP_REVISION = 'v1';
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

type Ctx = EvaluationContext<DeliveryCatchupData>;
const hasCandidates = ({ event }: Ctx) => ((event?.data as CatchupListed | undefined)?.candidates.length ?? 0) > 0;

export function deliveryCatchupChart(): DefinitionBuilder<DeliveryCatchupData> {
	return statechart<DeliveryCatchupData>({ family: CATCHUP_FAMILY, revision: CATCHUP_REVISION, name: 'delivery-catchup' })
		.data('firstDelayMs', CATCHUP_FIRST_DELAY_MS)
		.data('intervalMs', CATCHUP_INTERVAL_MS)
		.data('first', true)
		.data('candidates', [])
		.data('newest', null)
		.data('passes', 0)
		.data('lastRedelivered', 0)
		.data('lastError', null)
		.initial('idle')
		.state('idle', (s) =>
			s
				.entry((a) =>
					a.send(CATCHUP_EVENTS.tick, (b) => b.id(TICK_ID).after(({ data }: Ctx) => (data.first ? data.firstDelayMs : data.intervalMs)))
				)
				.exit((a) => a.cancel(TICK_ID).assign('first', false))
				.on(CATCHUP_EVENTS.tick, (t) => t.target('listing'))
				.on(CATCHUP_EVENTS.runNow, (t) => t.target('listing'))
		)
		.state('listing', (s) =>
			s
				.entry((a) => a.send(CATCHUP_EVENTS.list, (b) => b.via(CATCHUP_IO_TYPE).data(() => ({}))))
				.on(CATCHUP_EVENTS.listed, (t) =>
					t
						.when(hasCandidates)
						.target('redelivering')
						.assign('candidates', ({ event }: Ctx) => (event!.data as CatchupListed).candidates)
						.assign('newest', ({ event }: Ctx) => (event!.data as CatchupListed).newest)
				)
				.on(CATCHUP_EVENTS.listed, (t) =>
					t
						.target('idle')
						.assign('passes', ({ data }: Ctx) => data.passes + 1)
						.assign('lastRedelivered', 0)
						.assign('lastError', null)
				)
				.on(CATCHUP_EVENTS.failed, (t) =>
					t
						.target('idle')
						.assign('passes', ({ data }: Ctx) => data.passes + 1)
						.assign('lastError', ({ event }: Ctx) => (event!.data as CatchupFailed).error)
				)
				.on('error.communication', (t) => t.target('idle').assign('lastError', 'github-app processor failed'))
		)
		.state('redelivering', (s) =>
			s
				.entry((a) =>
					a.send(CATCHUP_EVENTS.redeliver, (b) =>
						b.via(CATCHUP_IO_TYPE).data(({ data }: Ctx): CatchupRedeliver => ({ ids: data.candidates.map((c) => c.id), newest: data.newest }))
					)
				)
				.on(CATCHUP_EVENTS.redelivered, (t) =>
					t
						.target('idle')
						.assign('passes', ({ data }: Ctx) => data.passes + 1)
						.assign('candidates', [])
						.assign('lastRedelivered', ({ event }: Ctx) => (event!.data as CatchupRedelivered).redelivered)
						.assign('lastError', ({ event }: Ctx) => (event!.data as CatchupRedelivered).lastError)
				)
				.on(CATCHUP_EVENTS.failed, (t) =>
					t
						.target('idle')
						.assign('passes', ({ data }: Ctx) => data.passes + 1)
						.assign('candidates', [])
						.assign('lastError', ({ event }: Ctx) => (event!.data as CatchupFailed).error)
				)
				.on('error.communication', (t) => t.target('idle').assign('candidates', []).assign('lastError', 'github-app processor failed'))
		);
}
