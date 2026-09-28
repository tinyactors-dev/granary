/**
 * `ops-config/main` — follows configuration changes (ADR 0082, 0111).
 *
 *   idle ──config.changed──▶ reconciling (entry: config.reconcile via backup-ledger)
 *   reconciling ──config.reconciled [dirty]──▶ reconciling   (another change arrived)
 *   reconciling ──config.reconciled──▶ idle
 *
 * OpsBackend posts `config.changed {area, id}` after its DB commit; the ledger
 * re-reads rows and spawns/replaces/destroys the long-lived actors
 * (backup-plan, retention, restore-drill), which get fresh bindings.
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO } from '../schemas/events';

export interface OpsConfigData {
	area: string | null;
	id: string | null;
	dirty: boolean;
	reconciles: number;
}

export const OPS_CONFIG_REVISION = 'v1';
export const OPS_CONFIG_STATES = { idle: 'idle', reconciling: 'reconciling' } as const;

type Ctx = EvaluationContext<OpsConfigData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

export function opsConfigChart(): DefinitionBuilder<OpsConfigData> {
	const S = OPS_CONFIG_STATES;
	return statechart<OpsConfigData>({ family: OPS_FAMILY.config, revision: OPS_CONFIG_REVISION, name: 'ops-config' })
		.data('area', null)
		.data('id', null)
		.data('dirty', false)
		.data('reconciles', 0)
		.initial(S.idle)
		.state(S.idle, (s) =>
			s.on('config.changed', (t) =>
				t
					.target(S.reconciling)
					.assign('area', (c: Ctx) => ev<{ area: string }>(c).area)
					.assign('id', (c: Ctx) => ev<{ id: string }>(c).id)
			)
		)
		.state(S.reconciling, (s) =>
			s
				.entry((a) =>
					a
						.assign('dirty', literal(false))
						.assign('reconciles', ({ data }: Ctx) => data.reconciles + 1)
						.send('config.reconcile', (b) => b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({ area: data.area, id: data.id })))
				)
				// A change while reconciling: remember it, reconcile everything once more.
				.on('config.changed', (t) => t.assign('dirty', literal(true)).assign('area', literal(null)).assign('id', literal(null)))
				.on('config.reconciled', (t) => t.when(({ data }: Ctx) => data.dirty).target(S.reconciling))
				.on('config.reconciled', (t) => t.target(S.idle))
				.on('error.communication', (t) => t.target(S.idle))
		);
}
