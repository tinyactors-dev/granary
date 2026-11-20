/**
 * `retention/<destinationId>` — bounded retention of one destination
 * (ADR 0082, 0096, 0111). Runs daily and before each upload ("make room
 * before writing"); passes are serialised, waiting uploads are queued.
 *
 *   idle (entry: retention.tick after dailyMs, id=tick)
 *     ──retention.tick──▶ pruning (daily)
 *     ──retention.make-room──▶ pruning (make-room for one upload)
 *   pruning (entry: retention.pass via object-store; list → plan → delete until converged)
 *     retention.make-room → queued
 *     ──retention.pass-done──▶ reply retention.room-made to the upload; next queued pass | idle
 *
 * The reply goes by name through `ops-route`: the upload may not be resident.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO, SEND_ID } from '../schemas/events';

interface Waiter {
	runId: string;
	database: string;
	estimatedBytes: number;
}

export interface RetentionData {
	destinationId: string;
	dailyMs: number;
	mode: 'daily' | 'make-room' | 'after-upload';
	current: Waiter | null;
	waiters: Waiter[];
	lastPass: { at: number; deleted: number; converged: boolean; floorExceedsCap: boolean } | null;
}

export const RETENTION_STATES = { idle: 'idle', pruning: 'pruning' } as const;

const S = RETENTION_STATES;

/** `retention.room-made` to the upload waiting for this pass, if any. */
const roomMade = (content: string) =>
	scxml`<if cond="current !== null"><send type="${OPS_IO.route}" event="retention.room-made" targetexpr="${`'${OPS_FAMILY.upload}/' + current.runId + '.' + destinationId`}"><content expr="${content}"/></send></if>`;

export const retentionChart = chart({
	name: OPS_FAMILY.retention,
	initial: S.idle,
	data: { destinationId: 'dest', dailyMs: 86_400_000, mode: 'daily', current: null, waiters: [], lastPass: null } satisfies RetentionData,
	body: scxml`
<state id="${S.idle}">
	<onentry><send event="retention.tick" id="${SEND_ID.tick}" delayexpr="dailyMs + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.tick}"/></onexit>
	<transition event="retention.tick" target="${S.pruning}">
		<assign location="mode" expr="'daily'"/>
		<assign location="current" expr="null"/>
	</transition>
	<transition event="retention.make-room" target="${S.pruning}">
		<assign location="mode" expr="'make-room'"/>
		<assign location="current" expr="_event.data"/>
	</transition>
</state>
<state id="${S.pruning}">
	<onentry>
		<send type="${OPS_IO.objectStore}" event="retention.pass">
			<content expr="${"({ destinationId: destinationId, mode: mode, database: current?.database ?? null, estimatedBytes: current?.estimatedBytes ?? 0, runId: current?.runId ?? null })"}"/>
		</send>
	</onentry>
	<transition event="retention.make-room"><assign location="waiters" expr="[...waiters, _event.data]"/></transition>
	<transition event="retention.pass-done">
		<assign location="lastPass" expr="({ at: Date.now(), deleted: _event.data.deleted, converged: _event.data.converged, floorExceedsCap: !!_event.data.floorExceedsCap })"/>
		${roomMade('({ runId: current.runId, deletedObjects: _event.data.deleted, freedBytes: _event.data.freedBytes })')}
		<raise event="retention.next"/>
	</transition>
	<transition event="error.communication">
		${roomMade('({ runId: current.runId, deletedObjects: 0, freedBytes: 0 })')}
		<raise event="retention.next"/>
	</transition>
	<!-- Internal: continue with the next queued upload, or rest. -->
	<transition event="retention.next" cond="waiters.length > 0" target="${S.pruning}">
		<assign location="mode" expr="'make-room'"/>
		<assign location="current" expr="waiters[0]"/>
		<assign location="waiters" expr="waiters.slice(1)"/>
	</transition>
	<transition event="retention.next" target="${S.idle}"><assign location="current" expr="null"/></transition>
</state>`
});
