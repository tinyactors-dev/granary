/**
 * Conditions, events, remediations, banner (ADR 0100, 0101).
 * No paging: states are ok / handled / attention only.
 */
import { Type, type Static } from '@sinclair/typebox';
import { OpsId, Timestamp } from './common';

/** Condition kinds (ADR 0100 table). Per-subject kinds are suffixed `.<id>`. */
export const ConditionKind = Type.Union([
	Type.Literal('offsite-backup-stale'), // .<planId>
	Type.Literal('destination-auth'), // .<destinationId>
	Type.Literal('restore-drill-failed'), // .<destinationId>
	Type.Literal('backup-blocked-disk'),
	Type.Literal('disk-low'),
	Type.Literal('retention-floor-exceeds-cap'), // .<destinationId>
	Type.Literal('telemetry-sink-down'), // .<sinkId>
	Type.Literal('outbox-dead'),
	Type.Literal('actors-quarantined'),
	Type.Literal('outbox-pending-old'),
	Type.Literal('webhooks-silent'),
	Type.Literal('master-key'),
	Type.Literal('no-offsite-destination')
]);
export type ConditionKind = Static<typeof ConditionKind>;

/** `<kind>` or `<kind>.<subjectId>`; also the actor name of condition/<id>. */
export const ConditionId = Type.String({ pattern: '^[a-z-]+(\\.[a-z0-9][a-z0-9-]{0,62})?$' });
export type ConditionId = Static<typeof ConditionId>;
export const conditionId = (kind: ConditionKind, subject?: string): string => (subject ? `${kind}.${subject}` : kind);

/** condition/<id> statechart states (ADR 0101). */
export const ConditionState = Type.Union([
	Type.Literal('ok'),
	Type.Literal('suspect'),
	Type.Literal('healing'),
	Type.Literal('attention'),
	Type.Literal('acknowledged')
]);
export type ConditionState = Static<typeof ConditionState>;

export const RemediationAction = Type.Union([
	Type.Literal('spool-cleanup'),
	Type.Literal('drop-local-copy'),
	Type.Literal('wal-checkpoint-truncate'),
	Type.Literal('postpone-backup'),
	Type.Literal('stretch-interval'),
	Type.Literal('retry-upload'),
	Type.Literal('rerun-drill'),
	Type.Literal('reset-sink-circuit'),
	Type.Literal('lower-sampling')
]);
export type RemediationAction = Static<typeof RemediationAction>;

export const Condition = Type.Object({
	id: ConditionId,
	kind: ConditionKind,
	subject: Type.Union([OpsId, Type.Null()]),
	state: ConditionState,
	title: Type.String(),
	/** Plain-language explanation for the morning (what happened, what was tried, what to do). */
	explanation: Type.String(),
	since: Type.Union([Timestamp, Type.Null()]),
	gracePeriodMs: Type.Integer({ minimum: 0 }),
	remediations: Type.Array(RemediationAction),
	lastRemediation: Type.Union([
		Type.Null(),
		Type.Object({ action: RemediationAction, at: Timestamp, outcome: Type.Union([Type.Literal('done'), Type.Literal('noop'), Type.Literal('failed')]) })
	]),
	acknowledgedBy: Type.Union([Type.String(), Type.Null()]),
	facts: Type.Record(Type.String(), Type.Unknown())
});
export type Condition = Static<typeof Condition>;

export const OpsEventKind = Type.Union([Type.Literal('info'), Type.Literal('handled'), Type.Literal('attention'), Type.Literal('ack')]);
export type OpsEventKind = Static<typeof OpsEventKind>;

export const OpsEvent = Type.Object({
	id: Type.String(),
	at: Timestamp,
	kind: OpsEventKind,
	conditionId: Type.Union([ConditionId, Type.Null()]),
	message: Type.String(),
	evidence: Type.Unknown()
});
export type OpsEvent = Static<typeof OpsEvent>;

/** "While you were away" banner (ADR 0100, 0104). */
export const Banner = Type.Object({
	since: Type.Union([Timestamp, Type.Null()]),
	handledCount: Type.Integer({ minimum: 0 }),
	attention: Type.Array(Type.Object({ id: ConditionId, title: Type.String(), since: Type.Union([Timestamp, Type.Null()]) })),
	/** One sentence summary, e.g. "Since 23:10: 4 things handled automatically, 1 needs you." */
	summary: Type.String(),
	show: Type.Boolean()
});
export type Banner = Static<typeof Banner>;
