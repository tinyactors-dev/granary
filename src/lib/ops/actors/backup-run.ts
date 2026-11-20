/**
 * `backup-run/<runId>` — one snapshot of one database, uploaded to each
 * destination of its plan (ADR 0082, 0098, 0111). Virtual: spawned with
 * params read from its `backup_runs` + `uploads` rows (at boot for an
 * unfinished run, or by `ops-route` when mail comes), so a crash at any step
 * resumes where the rows say.
 *
 *   restore ──(row state)──▶ idle | snapshotting | uploading
 *   idle ──run.start──▶ snapshotting
 *   snapshotting (entry: snapshot.request via snapshot)
 *     ──snapshot.ready──▶ uploading
 *     ──snapshot.failed [disk-insufficient]──▶ finalizing (postponed)
 *     ──snapshot.failed [attempt < 3]──▶ snapshotting
 *     ──snapshot.failed──▶ finalizing (failed)
 *   uploading (entry: run.uploads via backup-ledger → upload.start per destination)
 *     upload.done / upload.failed → tally; all terminal → finalizing
 *   finalizing (entry: run.finalize via backup-ledger) → succeeded | partial | failed | postponed
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO } from '../schemas/events';
import type { RawSnapshot } from '../backups/repo';

export type RunOutcome = 'succeeded' | 'partial' | 'failed' | 'postponed';

export interface BackupRunData {
	runId: string;
	planId: string;
	database: string;
	dbPath: string;
	spoolDir: string;
	destinationIds: string[];
	trigger: string;
	/** Row state at spawn time (restore routing). */
	phase: string;
	snapshot: RawSnapshot | null;
	/** destinationId → 'done' | 'failed' once terminal. */
	uploads: Record<string, 'done' | 'failed'>;
	attempt: number;
	sealedBytes: number | null;
	outcome: RunOutcome | null;
	error: string | null;
}

export const MAX_SNAPSHOT_ATTEMPTS = 3;
export const BACKUP_RUN_STATES = {
	restore: 'restore',
	idle: 'idle',
	snapshotting: 'snapshotting',
	uploading: 'uploading',
	finalizing: 'finalizing',
	succeeded: 'succeeded',
	partial: 'partial',
	failed: 'failed',
	postponed: 'postponed'
} as const;

const S = BACKUP_RUN_STATES;

const helpers = {
	allTerminal: (destinationIds: string[], uploads: Record<string, string>) => destinationIds.every((d) => uploads[d]),
	tallyOutcome: (destinationIds: string[], uploads: Record<string, string>) => {
		const states = destinationIds.map((d) => uploads[d]);
		if (!states.length) return 'failed';
		if (states.every((s) => s === 'done')) return 'succeeded';
		return states.some((s) => s === 'done') ? 'partial' : 'failed';
	},
	uploadError: (d: { destinationId: string; lastError: { code: string; message: string } }) => `${d.destinationId}: ${d.lastError.code} — ${d.lastError.message}`
};

const final = (name: RunOutcome) =>
	scxml`<final id="${name}"><donedata><content expr="${`({ runId: runId, state: '${name}', sealedBytes: sealedBytes })`}"/></donedata></final>`;

export const backupRunChart = chart({
	name: OPS_FAMILY.run,
	initial: S.restore,
	helpers,
	data: {
		runId: 'run',
		planId: 'plan',
		database: 'db',
		dbPath: '',
		spoolDir: '',
		destinationIds: [],
		trigger: 'schedule',
		phase: 'pending',
		snapshot: null,
		uploads: {},
		attempt: 0,
		sealedBytes: null,
		outcome: null,
		error: null
	} satisfies BackupRunData,
	body: scxml`
<state id="${S.restore}">
	<transition cond="phase === 'snapshotting'" target="${S.snapshotting}"/>
	<transition cond="${"phase === 'uploading' && snapshot !== null"}" target="${S.uploading}"/>
	<transition cond="phase === 'uploading'" target="${S.snapshotting}"/>
	<transition target="${S.idle}"/>
</state>
<state id="${S.idle}">
	<transition event="run.start" target="${S.snapshotting}">
		<assign location="destinationIds" expr="_event.data.destinationIds"/>
		<assign location="trigger" expr="_event.data.trigger"/>
	</transition>
</state>
<state id="${S.snapshotting}">
	<onentry>
		<assign location="attempt" expr="attempt + 1"/>
		<send type="${OPS_IO.snapshot}" event="snapshot.request"><content expr="({ runId: runId, database: database, dbPath: dbPath, spoolDir: spoolDir })"/></send>
	</onentry>
	<transition event="snapshot.ready" target="${S.uploading}"><assign location="snapshot" expr="_event.data"/></transition>
	<transition event="snapshot.failed" cond="_event.data.reason === 'disk-insufficient'" target="${S.finalizing}">
		<assign location="outcome" expr="'postponed'"/>
		<assign location="error" expr="_event.data.detail"/>
	</transition>
	<transition event="snapshot.failed" cond="${`attempt < ${MAX_SNAPSHOT_ATTEMPTS}`}" target="${S.snapshotting}">
		<assign location="error" expr="_event.data.detail"/>
	</transition>
	<transition event="snapshot.failed" target="${S.finalizing}">
		<assign location="outcome" expr="'failed'"/>
		<assign location="error" expr="'snapshot failed: ' + _event.data.detail"/>
	</transition>
	<transition event="error.communication" target="${S.finalizing}">
		<assign location="outcome" expr="'failed'"/>
		<assign location="error" expr="'snapshot processor unavailable'"/>
	</transition>
</state>
<state id="${S.uploading}">
	<onentry>
		<send type="${OPS_IO.ledger}" event="run.uploads"><content expr="({ runId: runId, destinationIds: destinationIds, snapshot: snapshot })"/></send>
	</onentry>
	<transition cond="allTerminal(destinationIds, uploads)" target="${S.finalizing}">
		<assign location="outcome" expr="tallyOutcome(destinationIds, uploads)"/>
	</transition>
	<transition event="upload.done">
		<assign location="uploads" expr="({ ...uploads, [_event.data.destinationId]: 'done' })"/>
		<assign location="sealedBytes" expr="Math.max(sealedBytes ?? 0, _event.data.sealedBytes)"/>
	</transition>
	<transition event="upload.failed">
		<assign location="uploads" expr="({ ...uploads, [_event.data.destinationId]: 'failed' })"/>
		<assign location="error" expr="uploadError(_event.data)"/>
	</transition>
</state>
<state id="${S.finalizing}">
	<onentry>
		<send type="${OPS_IO.ledger}" event="run.finalize">
			<content expr="${"({ runId: runId, planId: planId, state: outcome ?? 'failed', sealedBytes: sealedBytes, error: outcome === 'succeeded' ? null : error })"}"/>
		</send>
	</onentry>
	<transition cond="outcome === 'succeeded'" target="${S.succeeded}"/>
	<transition cond="outcome === 'partial'" target="${S.partial}"/>
	<transition cond="outcome === 'postponed'" target="${S.postponed}"/>
	<transition target="${S.failed}"/>
</state>
${final('succeeded')}
${final('partial')}
${final('failed')}
${final('postponed')}`
});
