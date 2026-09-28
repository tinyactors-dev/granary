/**
 * `remediator/main` — runs one self-healing action at a time (ADR 0101, 0123).
 *
 *   idle ──remediate──▶ working
 *   working (entry: <send type="remediate"> remediate.run {head of queue})
 *     ──remediated | remediation.failed (from the processor)──▶
 *         forward to condition/<id>, then working (next) | idle
 *   remediate while working → queued (deduplicated by condition + action)
 *
 * Every action is idempotent and re-derivable from current facts, so a
 * crash mid-remediation just re-evaluates on the next watchdog sample.
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, conditionAddress, opsTargetUri, type OpsEventData } from '../schemas/events';

export const REMEDIATOR_REVISION = 'v1';
export const REMEDIATE_IO_TYPE = 'remediate';
export const REMEDIATE_RUN_EVENT = 'remediate.run';

type Request = OpsEventData<'remediate'>;

export interface RemediatorData {
	queue: Request[];
	current: Request | null;
	/** Last result per condition, for listings. */
	done: number;
	failed: number;
}

type Ctx = EvaluationContext<RemediatorData>;

function enqueue({ data, event }: Ctx) {
	const r = event!.data as Request;
	const dup = (x: Request | null) => !!x && x.conditionId === r.conditionId && x.action === r.action;
	if (dup(data.current) || data.queue.some(dup)) return;
	data.queue.push(r);
}

function take({ data }: Ctx): Request {
	data.current = data.queue.shift() ?? null;
	return data.current!;
}

const replyTarget = (ctx: Ctx) => opsTargetUri(conditionAddress((ctx.event!.data as { conditionId: string }).conditionId));

function finish(ctx: Ctx) {
	if (ctx.event!.name === 'remediation.failed') ctx.data.failed++;
	else ctx.data.done++;
	ctx.data.current = null;
}

export function remediatorChart(): DefinitionBuilder<RemediatorData> {
	return statechart<RemediatorData>({ family: OPS_FAMILY.remediator, revision: REMEDIATOR_REVISION, name: 'remediator' })
		.data('queue', [])
		.data('current', null)
		.data('done', 0)
		.data('failed', 0)
		.initial('idle')
		.state('idle', (s) => s.on('remediate', (t) => t.target('working').script(enqueue)))
		.state('working', (s) =>
			s
				.entry((a) => a.send(REMEDIATE_RUN_EVENT, (b) => b.via(REMEDIATE_IO_TYPE).data(take)))
				.on('remediate', (t) => t.internal().script(enqueue))
				.on('remediated', (t) =>
					t
						.when(({ data }: Ctx) => data.queue.length > 0)
						.target('working')
						.send('remediated', (b) => b.to(replyTarget).data(({ event }: Ctx) => event!.data))
						.script(finish)
				)
				.on('remediated', (t) =>
					t
						.target('idle')
						.send('remediated', (b) => b.to(replyTarget).data(({ event }: Ctx) => event!.data))
						.script(finish)
				)
				.on('remediation.failed', (t) =>
					t
						.when(({ data }: Ctx) => data.queue.length > 0)
						.target('working')
						.send('remediation.failed', (b) => b.to(replyTarget).data(({ event }: Ctx) => event!.data))
						.script(finish)
				)
				.on('remediation.failed', (t) =>
					t
						.target('idle')
						.send('remediation.failed', (b) => b.to(replyTarget).data(({ event }: Ctx) => event!.data))
						.script(finish)
				)
				.on('error.communication', (t) => t.target('idle').script(({ data }: Ctx) => {
					data.current = null;
					data.failed++;
				}))
		);
}
