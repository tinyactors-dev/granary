/**
 * `upload/<runId>.<destinationId>` — one sealed artifact to one destination
 * (ADR 0082, 0095, 0096, 0098, 0111). Virtual: spawned with params read from
 * its `uploads` row (at boot, or by `ops-route` when `upload.start` comes).
 *
 *   restore ──(row state)──▶ idle | making-room | committing | verifying | retry-wait
 *   idle ──upload.start──▶ making-room
 *   making-room (entry: retention.make-room → retention/<dest>; room timeout)
 *     ──retention.room-made | upload.room-timeout──▶ uploading
 *   uploading (entry: store.put-artifact via object-store; seals while streaming)
 *     ──store.artifact-stored──▶ committing
 *   committing (entry: store.put-manifest, If-None-Match: * — the commit marker)
 *     ──store.manifest-committed──▶ verifying
 *   verifying (entry: store.verify) ──store.verified──▶ done
 *   store.error [retryable, attempts < max] ──▶ retry-wait ──upload.retry──▶ uploading | committing
 *   store.error ──▶ failed
 *   done   → upload.done → backup-run/<runId> (local-dir: retention.tick to keep one copy)
 *   failed → upload.record-failed via backup-ledger; upload.failed → backup-run/<runId>
 *
 * Sends to `backup-run/*` and `retention/*` go by name through `ops-route`.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO, SEND_ID } from '../schemas/events';
import type { BackupManifest } from '../schemas/manifest';
import type { StoreError } from '../schemas/runs';
import type { RawSnapshot } from '../backups/repo';

export interface UploadData {
	runId: string;
	destinationId: string;
	database: string;
	local: boolean;
	phase: string;
	snapshot: RawSnapshot | null;
	artifactKey: string | null;
	manifest: BackupManifest | null;
	attempts: number;
	maxAttempts: number;
	retryBaseMs: number;
	makeRoomTimeoutMs: number;
	nextAttemptAt: number | null;
	lastError: StoreError | null;
	/** Estimated sealed size, for make-room (last sealed × 1.1, else raw). */
	estimatedBytes: number;
}

export const ROOM_SEND_ID = 'room';
export const MAX_RETRY_DELAY_MS = 30 * 60_000;
export const UPLOAD_STATES = {
	restore: 'restore',
	idle: 'idle',
	makingRoom: 'making-room',
	uploading: 'uploading',
	committing: 'committing',
	verifying: 'verifying',
	retryWait: 'retry-wait',
	done: 'done',
	failed: 'failed'
} as const;

const S = UPLOAD_STATES;

const helpers = {
	canRetry: (e: StoreError, attempts: number, maxAttempts: number) => e.retryable && attempts < maxAttempts,
	/** When the next attempt is due: the store's Retry-After, else exponential backoff (MAX_RETRY_DELAY_MS = 30 min). */
	nextAttempt: (e: StoreError, attempts: number, retryBaseMs: number) =>
		Date.now() + (e.retryAfterMs ?? Math.min(30 * 60_000, retryBaseMs * 2 ** Math.max(0, attempts - 1))),
	retryDelay: (nextAttemptAt: number | null, attempts: number, retryBaseMs: number) =>
		nextAttemptAt !== null ? Math.max(0, nextAttemptAt - Date.now()) : Math.min(30 * 60_000, retryBaseMs * 2 ** Math.max(0, attempts - 1)),
	/** `manifestKeyOf` (schemas/destinations): the manifest sits next to its artifact. */
	manifestKey: (artifactKey: string) => `${artifactKey}.manifest.json`
};

const PROCESSOR_DOWN: StoreError = { code: 'other', retryable: false, status: null, providerCode: null, message: 'object-store processor unavailable', retryAfterMs: null };

/** store.error handling shared by uploading/committing/verifying. */
const onStoreError = scxml`
	<transition event="store.error" cond="canRetry(_event.data.error, attempts, maxAttempts)" target="${S.retryWait}">
		<assign location="lastError" expr="_event.data.error"/>
		<!-- Integrity failures (manifest withdrawn / object incomplete) restart from a full upload. -->
		<assign location="manifest" expr="${"_event.data.error.code === 'integrity' ? null : manifest"}"/>
		<assign location="nextAttemptAt" expr="nextAttempt(_event.data.error, attempts, retryBaseMs)"/>
	</transition>
	<transition event="store.error" target="${S.failed}"><assign location="lastError" expr="_event.data.error"/></transition>
	<transition event="error.communication" target="${S.failed}"><assign location="lastError" expr="${JSON.stringify(PROCESSOR_DOWN)}"/></transition>`;

const toRun = (event: string, content: string) =>
	scxml`<send type="${OPS_IO.route}" event="${event}" targetexpr="${`'${OPS_FAMILY.run}/' + runId`}"><content expr="${content}"/></send>`;
const toRetention = (event: string, content: string | null) =>
	scxml`<send type="${OPS_IO.route}" event="${event}" targetexpr="${`'${OPS_FAMILY.retention}/' + destinationId`}">${content ? scxml`<content expr="${content}"/>` : ''}</send>`;

export const uploadChart = chart({
	name: OPS_FAMILY.upload,
	initial: S.restore,
	helpers,
	data: {
		runId: 'run',
		destinationId: 'dest',
		database: 'db',
		local: false,
		phase: 'pending',
		snapshot: null,
		artifactKey: null,
		manifest: null,
		attempts: 0,
		maxAttempts: 6,
		retryBaseMs: 30_000,
		makeRoomTimeoutMs: 600_000,
		nextAttemptAt: null,
		lastError: null,
		estimatedBytes: 0
	} satisfies UploadData,
	body: scxml`
<state id="${S.restore}">
	<transition cond="${"phase === 'retry-wait' && snapshot !== null"}" target="${S.retryWait}"/>
	<transition cond="${"phase === 'verifying' && manifest !== null"}" target="${S.verifying}"/>
	<transition cond="${"phase === 'committing' && manifest !== null"}" target="${S.committing}"/>
	<transition cond="${"(phase === 'making-room' || phase === 'uploading') && snapshot !== null"}" target="${S.makingRoom}"/>
	<transition target="${S.idle}"/>
</state>
<state id="${S.idle}">
	<transition event="upload.start" target="${S.makingRoom}">
		<assign location="snapshot" expr="_event.data.snapshot"/>
		<assign location="artifactKey" expr="_event.data.artifactKey ?? artifactKey"/>
		<assign location="estimatedBytes" expr="${'estimatedBytes || _event.data.snapshot.rawBytes'}"/>
	</transition>
</state>
<state id="${S.makingRoom}">
	<onentry>
		${toRetention('retention.make-room', '({ destinationId: destinationId, database: database, estimatedBytes: estimatedBytes, runId: runId })')}
		<send event="upload.room-timeout" id="${ROOM_SEND_ID}" delayexpr="makeRoomTimeoutMs + 'ms'"/>
	</onentry>
	<onexit><cancel sendid="${ROOM_SEND_ID}"/></onexit>
	<transition event="retention.room-made" target="${S.uploading}"/>
	<transition event="upload.room-timeout" target="${S.uploading}"/>
</state>
<state id="${S.uploading}">
	<onentry>
		<assign location="attempts" expr="attempts + 1"/>
		<assign location="nextAttemptAt" expr="null"/>
		<send type="${OPS_IO.objectStore}" event="store.put-artifact"><content expr="({ runId: runId, destinationId: destinationId, snapshot: snapshot, artifactKey: artifactKey })"/></send>
	</onentry>
	<transition event="store.artifact-stored" target="${S.committing}"><assign location="manifest" expr="_event.data.manifest"/></transition>
	${onStoreError}
</state>
<state id="${S.committing}">
	<onentry>
		<assign location="nextAttemptAt" expr="null"/>
		<send type="${OPS_IO.objectStore}" event="store.put-manifest"><content expr="({ runId: runId, destinationId: destinationId, manifest: manifest })"/></send>
	</onentry>
	<transition event="store.manifest-committed" target="${S.verifying}"/>
	${onStoreError}
</state>
<state id="${S.verifying}">
	<onentry>
		<send type="${OPS_IO.objectStore}" event="store.verify"><content expr="({ runId: runId, destinationId: destinationId, manifest: manifest })"/></send>
	</onentry>
	<transition event="store.verified" target="${S.done}"/>
	${onStoreError}
</state>
<state id="${S.retryWait}">
	<onentry>
		<send type="${OPS_IO.ledger}" event="upload.record-retry">
			<content expr="({ runId: runId, destinationId: destinationId, attempts: attempts, nextAttemptAt: nextAttemptAt ?? Date.now(), lastError: lastError })"/>
		</send>
		<send event="upload.retry" id="${SEND_ID.retry}" delayexpr="retryDelay(nextAttemptAt, attempts, retryBaseMs) + 'ms'"/>
	</onentry>
	<onexit><cancel sendid="${SEND_ID.retry}"/></onexit>
	<transition event="upload.retry" cond="manifest !== null" target="${S.committing}"><assign location="attempts" expr="attempts + 1"/></transition>
	<transition event="upload.retry" target="${S.uploading}"/>
</state>
<final id="${S.done}">
	<onentry>
		${toRun('upload.done', '({ runId: runId, destinationId: destinationId, manifestKey: manifestKey(manifest.artifactKey), sealedBytes: manifest.sealed.bytes })')}
		<if cond="local">${toRetention('retention.tick', null)}</if>
	</onentry>
	<donedata><content expr="({ runId: runId, destinationId: destinationId, state: 'done' })"/></donedata>
</final>
<final id="${S.failed}">
	<onentry>
		<send type="${OPS_IO.ledger}" event="upload.record-failed"><content expr="({ runId: runId, destinationId: destinationId, attempts: attempts, lastError: lastError })"/></send>
		${toRun('upload.failed', '({ runId: runId, destinationId: destinationId, attempts: attempts, lastError: lastError })')}
	</onentry>
	<donedata><content expr="({ runId: runId, destinationId: destinationId, state: 'failed' })"/></donedata>
</final>`
});
