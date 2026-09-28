/**
 * Dev-only remote functions backing `/admin` (ADR 0009, ADR 0031).
 * Every function calls `requireAdminArea(<capability>)` first (ADR 0290): admins in every environment; 404 where the area isn't available.
 * They do not require a signed-in user (the dev page is how you sign in).
 */
import { command, form, getRequestEvent, query, requested } from '$app/server';
import { error, invalid, redirect } from '@sveltejs/kit';
import { standard } from '$lib/schemas/standard';
import {
	DevInjectFaultInput,
	DevLoginAsInput,
	DevOpenIssueInput,
	DevRedeliverInput,
	DevReopenIssueInput,
	DevSendEventInput,
	GetDapLaunchConfigInput,
	GetRecentSpansInput,
	ListRecentTracesInput,
	type DapLaunchConfig,
	type DevInfo,
	type DevTool,
	type DevInjectFaultResult,
	type DevOpenIssueResult,
	type DevRedeliverResult,
	type DevReopenIssueResult,
	type DevSendEventResult,
	type SpanSummary,
	type TraceSummary
} from '$lib/schemas/dev';
import { requireAdminArea, safeRedirectPath, setSessionCookie } from '$lib/server/auth';
import { backendErrorStatus, getBackend, isBackendError } from '$lib/server/backend';
import { withBackend } from '$lib/server/remote-helpers';
import { getIssue, getOverview, listDeliveries } from './dashboard.remote';
import { listActors } from './actors.remote';

const DEFAULT_SPAN_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 50;

/** DAP port, fake GitHub URL + state (users, repos, issues, deliveries, faults), admins. */
export const getDevInfo = query(async (): Promise<DevInfo> => {
	requireAdminArea();
	return withBackend((b) => b.getDevInfo());
});

/** Every UI worth opening (granary pages, fakes, Grafana, storage consoles) with reachability (ADR 0154). */
export const getDevTools = query(async (): Promise<DevTool[]> => {
	requireAdminArea();
	return withBackend((b) => b.getDevTools());
});

/**
 * Form `{login, redirectTo?}`: create a session for any login (no OAuth),
 * set the `granary_session` cookie, then 303 to `redirectTo` (default `/`).
 */
export const devLoginAs = form(standard(DevLoginAsInput), async ({ login, redirectTo }): Promise<never> => {
	requireAdminArea('impersonate');
	const { cookies, url, locals } = getRequestEvent();
	const session = await withBackend((b) => b.createSession({ login }));
	setSessionCookie(cookies, session.sessionId, session.expiresAt, url);
	locals.user = session.user;
	locals.sessionId = session.sessionId;
	redirect(303, safeRedirectPath(redirectTo));
});

/**
 * Form `{owner, repo, author, title, body?, association?}`: open an issue on the
 * fake GitHub as `author` (delivers `issues.opened` to the app).
 */
export const devOpenIssue = form(
	standard(DevOpenIssueInput),
	async (input): Promise<DevOpenIssueResult> => {
		requireAdminArea('fakeGithub');
		let result: DevOpenIssueResult;
		try {
			result = await getBackend().devOpenIssue(input);
		} catch (e) {
			// Surface fake-GitHub failures on the form (form-level issue) rather than as an error page.
			if (isBackendError(e) && (e.code === 'upstream' || e.code === 'invalid')) invalid(e.message);
			if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
			throw e;
		}
		await Promise.all([getDevInfo().refresh(), getOverview().refresh(), requested(listDeliveries, 5).refreshAll()]);
		return result;
	}
);

/** Command `{owner, repo, number, actor}`: reopen on the fake (delivers `issues.reopened`). */
export const devReopenIssue = command(
	standard(DevReopenIssueInput),
	async (input): Promise<DevReopenIssueResult> => {
		requireAdminArea('fakeGithub');
		const result = await withBackend((b) => b.devReopenIssue(input));
		await Promise.all([getDevInfo().refresh(), getOverview().refresh()]);
		return result;
	}
);

/** Command `{deliveryId}`: the fake resends the delivery with the same id. */
export const devRedeliver = command(
	standard(DevRedeliverInput),
	async ({ deliveryId }): Promise<DevRedeliverResult> => {
		requireAdminArea('fakeGithub');
		const result = await withBackend((b) => b.devRedeliver(deliveryId));
		await Promise.all([getDevInfo().refresh(), getOverview().refresh()]);
		return result;
	}
);

/**
 * Form `{method, pathPattern, status, count, retryAfter?}` (numbers via `.as('number')`):
 * the next `count` matching fake GitHub REST calls fail with `status`.
 */
export const devInjectFault = form(
	standard(DevInjectFaultInput),
	async (input): Promise<DevInjectFaultResult> => {
		requireAdminArea('fakeGithub');
		const result = await withBackend((b) => b.devInjectFault(input));
		await getDevInfo().refresh();
		return result;
	}
);

/** Command: `POST /__control/reset` on the fake GitHub (app DB untouched). */
export const devReset = command(async (): Promise<{ ok: true }> => {
	requireAdminArea('fakeGithub');
	await withBackend((b) => b.devReset());
	await getDevInfo().refresh();
	return { ok: true };
});

/**
 * Command `{address:{family,name}, event, data?}` where `data` is JSON text.
 * Sends the event to the actor and waits for its macrostep.
 */
export const devSendEvent = command(
	standard(DevSendEventInput),
	async ({ address, event, data }): Promise<DevSendEventResult> => {
		requireAdminArea('debugger');
		let parsed: unknown = undefined;
		if (data !== undefined && data.trim() !== '') {
			try {
				parsed = JSON.parse(data);
			} catch (e) {
				error(400, `data is not valid JSON: ${(e as Error).message}`);
			}
		}
		const result = await withBackend((b) => b.devSendEvent({ address, event, data: parsed }));
		await Promise.all([listActors().refresh(), requested(getIssue, 5).refreshAll()]);
		return result;
	}
);

/**
 * Last spans from the app's in-memory trace buffer, newest first. `limit`
 * default 100, max SPAN_BUFFER_SIZE; with `traceId` + a large limit it returns
 * one whole trace (ADR 0054).
 */
export const getRecentSpans = query(
	standard(GetRecentSpansInput),
	async (input): Promise<SpanSummary[]> => {
		requireAdminArea();
		return withBackend((b) => b.getRecentSpans({ ...input, limit: input.limit ?? DEFAULT_SPAN_LIMIT }));
	}
);

/** The trace buffer grouped by trace, newest first (ADR 0054). `limit` default 50. */
export const listRecentTraces = query(
	standard(ListRecentTracesInput),
	async (input): Promise<TraceSummary[]> => {
		requireAdminArea();
		return withBackend((b) => b.listRecentTraces({ ...input, limit: input.limit ?? DEFAULT_TRACE_LIMIT }));
	}
);

/** VS Code launch.json attach configuration for `address`. */
export const getDapLaunchConfig = query(
	standard(GetDapLaunchConfigInput),
	async ({ address }): Promise<DapLaunchConfig> => {
		requireAdminArea('debugger');
		return withBackend((b) => b.getDapLaunchConfig(address));
	}
);
