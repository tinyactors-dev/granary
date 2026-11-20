/**
 * `restore-drill/<destinationId>` — weekly proof that backups restore
 * (ADR 0082, 0091, 0111). For each database backed up to the destination:
 * download the newest committed backup, decrypt, verify sha256s, then
 * integrity_check + row counts against the manifest in the Worker.
 *
 *   armed (entry: drill.tick after lastDrillAt + interval − now, id=tick)
 *     ──drill.tick | drill.run-now──▶ fetching (queue = databases)
 *   fetching (entry: drill.fetch via object-store)
 *     ──drill.fetched──▶ checking
 *     ──drill.checked (fetch failed)──▶ next
 *   checking (entry: drill.check via snapshot) ──drill.checked──▶ next
 *   next: more databases → fetching, else armed (lastDrillAt = now)
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO, SEND_ID } from '../schemas/events';
import type { BackupManifest } from '../schemas/manifest';

export interface RestoreDrillData {
	destinationId: string;
	intervalMs: number;
	lastDrillAt: number | null;
	databases: string[];
	queue: string[];
	drillId: string | null;
	database: string | null;
	localPath: string | null;
	runId: string | null;
	manifest: BackupManifest | null;
	requestedBy: string | null;
	lastResult: string | null;
}

export const RESTORE_DRILL_STATES = { armed: 'armed', fetching: 'fetching', checking: 'checking' } as const;

const S = RESTORE_DRILL_STATES;

const helpers = {
	dueIn: (lastDrillAt: number | null, intervalMs: number) => Math.max(0, (lastDrillAt ?? Date.now()) + intervalMs - Date.now()),
	newDrillId: () => `drill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
};

/** Start a drill of every database (`drill.tick`, `drill.run-now`). */
const start = (event: string, extra = '') => scxml`
	<transition event="${event}" cond="databases.length > 0" target="${S.fetching}">
		<assign location="queue" expr="databases.slice(1)"/>
		<assign location="database" expr="databases[0]"/>
		${extra ? scxml`<assign location="requestedBy" expr="${extra}"/>` : ''}
	</transition>`;

/** Go on with the next queued database. */
const next = (event: string, result: string) => scxml`
	<transition event="${event}" cond="queue.length > 0" target="${S.fetching}">
		<assign location="lastResult" expr="${result}"/>
		<assign location="database" expr="queue[0]"/>
		<assign location="queue" expr="queue.slice(1)"/>
	</transition>`;

export const restoreDrillChart = chart({
	name: OPS_FAMILY.drill,
	initial: S.armed,
	helpers,
	data: {
		destinationId: 'dest',
		intervalMs: 7 * 86_400_000,
		lastDrillAt: null,
		databases: [],
		queue: [],
		drillId: null,
		database: null,
		localPath: null,
		runId: null,
		manifest: null,
		requestedBy: null,
		lastResult: null
	} satisfies RestoreDrillData,
	body: scxml`
<state id="${S.armed}">
	<onentry><send event="drill.tick" id="${SEND_ID.tick}" delayexpr="dueIn(lastDrillAt, intervalMs) + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.tick}"/></onexit>
	${start('drill.tick')}
	<transition event="drill.tick" target="${S.armed}"><assign location="lastDrillAt" expr="Date.now()"/></transition>
	${start('drill.run-now', '_event.data.requestedBy')}
</state>
<state id="${S.fetching}">
	<onentry>
		<assign location="drillId" expr="newDrillId()"/>
		<assign location="manifest" expr="null"/>
		<send type="${OPS_IO.objectStore}" event="drill.fetch"><content expr="({ drillId: drillId, destinationId: destinationId, database: database })"/></send>
	</onentry>
	<transition event="drill.fetched" target="${S.checking}">
		<assign location="localPath" expr="_event.data.localPath"/>
		<assign location="runId" expr="_event.data.runId"/>
		<assign location="manifest" expr="_event.data.manifest"/>
	</transition>
	<!-- The fetch failed (drill.checked from the object store) or the processor is down: next database. -->
	${next('drill.checked', '_event.data.result')}
	<transition event="drill.checked" target="${S.armed}">
		<assign location="lastResult" expr="_event.data.result"/>
		<assign location="lastDrillAt" expr="Date.now()"/>
	</transition>
	${next('error.communication', "'download-failed'")}
	<transition event="error.communication" target="${S.armed}">
		<assign location="lastResult" expr="'download-failed'"/>
		<assign location="lastDrillAt" expr="Date.now()"/>
	</transition>
</state>
<state id="${S.checking}">
	<onentry>
		<send type="${OPS_IO.snapshot}" event="drill.check">
			<content expr="({ drillId: drillId, destinationId: destinationId, runId: runId, localPath: localPath, manifest: manifest })"/>
		</send>
	</onentry>
	${next('drill.checked', '_event.data.result')}
	<transition event="drill.checked" target="${S.armed}">
		<assign location="lastResult" expr="_event.data.result"/>
		<assign location="lastDrillAt" expr="Date.now()"/>
	</transition>
	<transition event="error.communication" target="${S.armed}">
		<assign location="lastResult" expr="'integrity-failed'"/>
		<assign location="lastDrillAt" expr="Date.now()"/>
	</transition>
</state>`
});
