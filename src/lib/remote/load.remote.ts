/**
 * Dev-only remote functions for the load generator portal (ADR 0076).
 * Every function calls `requireAdminArea(<capability>)` first (ADR 0290): admins in every environment; 404 where the area isn't available.
 */
import { command, query } from '$app/server';
import { standard } from '$lib/schemas/standard';
import {
	ControlScenarioInput,
	CreateScenarioRequest,
	GetPersonaInput,
	ListPersonasQuery,
	ScenarioIdInput,
	type LoadgenInfo,
	type PersonaDetail,
	type PersonaKindInfo,
	type PersonaSummary,
	type ScenarioDetail,
	type ScenarioSummary
} from '$lib/schemas/dev';
import { requireAdminArea } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Reachability + status of the loadgen (never errors when it is down). */
export const getLoadgenStatus = query(async (): Promise<LoadgenInfo> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.getLoadgenStatus());
});

export const listScenarios = query(async (): Promise<ScenarioSummary[]> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.listScenarios());
});

export const getScenario = query(standard(ScenarioIdInput), async ({ id }): Promise<ScenarioDetail> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.getScenario(id));
});

/** Command `{preset?, config?, start?}` → the new scenario. */
export const createScenario = command(standard(CreateScenarioRequest), async (req): Promise<ScenarioSummary> => {
	requireAdminArea('loadgen');
	const created = await withBackend((b) => b.createScenario(req));
	await Promise.all([listScenarios().refresh(), getLoadgenStatus().refresh()]);
	return created;
});

/** Command `{id, action: start|pause|resume|stop}`. */
export const controlScenario = command(standard(ControlScenarioInput), async ({ id, action }): Promise<ScenarioSummary> => {
	requireAdminArea('loadgen');
	const s = await withBackend((b) => b.controlScenario(id, action));
	await Promise.all([listScenarios().refresh(), getScenario({ id }).refresh(), getLoadgenStatus().refresh()]);
	return s;
});

export const listPersonas = query(standard(ListPersonasQuery), async (q): Promise<PersonaSummary[]> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.listPersonas(q));
});

export const getPersona = query(standard(GetPersonaInput), async ({ kind, name }): Promise<PersonaDetail> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.getPersona(kind, name));
});

/** The persona catalogue with statecharts. */
export const listPersonaKinds = query(async (): Promise<PersonaKindInfo[]> => {
	requireAdminArea('loadgen');
	return withBackend((b) => b.listPersonaKinds());
});

/** Command: stop everything and forget all scenarios. */
export const resetLoadgen = command(async (): Promise<{ ok: true }> => {
	requireAdminArea('loadgen');
	await withBackend((b) => b.resetLoadgen());
	await Promise.all([listScenarios().refresh(), getLoadgenStatus().refresh()]);
	return { ok: true };
});
