/**
 * Actor-system introspection (ADR 0031, ADR 0056).
 */
import { getRequestEvent, query } from '$app/server';
import { InspectActorInput, type ActorSnapshot, type ActorSummary } from '$lib/schemas/api';
import { standard } from '$lib/schemas/standard';
import { requireUser } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Resident actors with active states, scheduling, residency and macrostep info. */
export const listActors = query(async (): Promise<ActorSummary[]> => {
	requireUser();
	return withBackend((b) => b.listActors());
});

/**
 * Full snapshot of one resident actor (null when none is resident there).
 * Signed-in users, or anyone in dev mode (like the dev console).
 */
export const inspectActor = query(
	standard(InspectActorInput),
	async ({ address }): Promise<ActorSnapshot | null> => {
		if (!getRequestEvent().locals.devMode) requireUser();
		return withBackend((b) => b.inspectActor(address));
	}
);
