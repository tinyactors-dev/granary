/**
 * Actor-system introspection (ADR 0031, ADR 0056): the admin section only (ADR 0290).
 */
import { query } from '$app/server';
import { InspectActorInput, type ActorSnapshot, type ActorSummary } from '$lib/schemas/api';
import { standard } from '$lib/schemas/standard';
import { requireAdminArea } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Resident actors with active states, scheduling, residency and macrostep info. */
export const listActors = query(async (): Promise<ActorSummary[]> => {
	requireAdminArea();
	return withBackend((b) => b.listActors());
});

/**
 * Full snapshot of one resident actor (null when none is resident there).
 * Admins (anyone in development mode), like the rest of /admin.
 */
export const inspectActor = query(
	standard(InspectActorInput),
	async ({ address }): Promise<ActorSnapshot | null> => {
		requireAdminArea();
		return withBackend((b) => b.inspectActor(address));
	}
);
