/**
 * `ops-config/main` — follows configuration changes (ADR 0082, 0111).
 *
 *   idle ──config.changed──▶ reconciling (entry: config.reconcile via backup-ledger)
 *   reconciling ──config.reconciled [dirty]──▶ reconciling   (another change arrived)
 *   reconciling ──config.reconciled──▶ idle
 *
 * OpsBackend posts `config.changed {area, id}` after its DB commit; the ledger
 * re-reads rows and spawns/replaces/terminates the long-lived actors
 * (backup-plan, retention, restore-drill), which get fresh params.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO } from '../schemas/events';

export interface OpsConfigData {
	area: string | null;
	id: string | null;
	dirty: boolean;
	reconciles: number;
}

export const OPS_CONFIG_STATES = { idle: 'idle', reconciling: 'reconciling' } as const;

const S = OPS_CONFIG_STATES;

export const opsConfigChart = chart({
	name: OPS_FAMILY.config,
	initial: S.idle,
	data: { area: null, id: null, dirty: false, reconciles: 0 } satisfies OpsConfigData,
	body: scxml`
<state id="${S.idle}">
	<transition event="config.changed" target="${S.reconciling}">
		<assign location="area" expr="_event.data.area"/>
		<assign location="id" expr="_event.data.id"/>
	</transition>
</state>
<state id="${S.reconciling}">
	<onentry>
		<assign location="dirty" expr="false"/>
		<assign location="reconciles" expr="reconciles + 1"/>
		<send type="${OPS_IO.ledger}" event="config.reconcile"><content expr="({ area: area, id: id })"/></send>
	</onentry>
	<!-- A change while reconciling: remember it, reconcile everything once more. -->
	<transition event="config.changed">
		<assign location="dirty" expr="true"/>
		<assign location="area" expr="null"/>
		<assign location="id" expr="null"/>
	</transition>
	<transition event="config.reconciled" cond="dirty" target="${S.reconciling}"/>
	<transition event="config.reconciled" target="${S.idle}"/>
	<transition event="error" target="${S.idle}"/>
</state>`
});
