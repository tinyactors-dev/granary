/**
 * `apps/main` — the fake's GitHub Apps (ADR 0164, ADR 0200): registered apps,
 * single-use manifest codes, installations, installation access tokens and
 * each app's webhook delivery log.
 *
 * The HTTP host does the crypto (key generation, JWT verification) and asks
 * this actor for data. Private keys are never stored: a manifest code holds
 * the PEM only until its one conversion.
 */
import { statechart } from '@tinyactors/node';
import { answer, type ActorFailure } from '../io/reply';

export const APPS_ADDRESS = { family: 'apps', name: 'main' } as const;

export interface AppRecord {
	id: number;
	slug: string;
	name: string;
	owner: string;
	ownerId: number;
	ownerType: 'User' | 'Organization';
	clientId: string;
	clientSecret: string;
	webhookSecret: string;
	publicKeyPem: string;
	webhookUrl: string;
	webhookActive: boolean;
	redirectUrl: string;
	setupUrl: string | null;
	callbackUrls: string[];
	url: string;
	description: string;
	permissions: Record<string, string>;
	events: string[];
	createdAt: number;
}

export interface InstallationRecord {
	id: number;
	appId: number;
	account: string;
	accountId: number;
	accountType: 'User' | 'Organization';
	repositorySelection: 'all' | 'selected';
	/** Lower-cased `owner/name` when `selected`. */
	repos: string[];
	suspended: boolean;
	createdAt: number;
	/**
	 * Permissions and events the account accepted (ADR 0282): copied from the
	 * app at install time; later app changes apply only after
	 * `apps.accept-permissions` (GitHub's "Review request" → accept).
	 */
	permissions: Record<string, string>;
	events: string[];
}

export interface AppDeliveryRecord {
	id: number;
	appId: number;
	guid: string;
	event: string;
	action: string | null;
	deliveredAt: number;
	redelivery: boolean;
	statusCode: number;
	durationMs: number;
	installationId: number | null;
	repositoryId: number | null;
}

export interface AppsData {
	apps: AppRecord[];
	/** manifest code → pending conversion */
	codes: Record<string, { appId: number; pem: string; expiresAt: number }>;
	installations: InstallationRecord[];
	/** installation token → installation */
	tokens: Record<string, { installationId: number; expiresAt: number }>;
	deliveries: AppDeliveryRecord[];
	out: unknown;
}

export const APPS_EVENTS = {
	create: 'apps.create',
	convert: 'apps.convert',
	find: 'apps.find',
	install: 'apps.install',
	installations: 'apps.installations',
	createToken: 'apps.create-token',
	resolveToken: 'apps.resolve-token',
	covering: 'apps.covering',
	recordDelivery: 'apps.record-delivery',
	deliveries: 'apps.deliveries',
	setPermissions: 'apps.set-permissions',
	acceptPermissions: 'apps.accept-permissions'
} as const;

const fail = (status: number, error: string): ActorFailure => ({ status, error });

export interface CreateAppEvent {
	app: AppRecord;
	code: string;
	pem: string;
	now: number;
}

/** By id, client id or slug. */
export interface FindAppEvent {
	id?: number;
	clientId?: string;
	slug?: string;
}

export interface InstallEvent {
	appId: number;
	newId: number;
	account: string;
	accountId: number;
	accountType: 'User' | 'Organization';
	selection: 'all' | 'selected';
	repos: string[];
	now: number;
}

/** What changed; the host turns it into `installation` / `installation_repositories` webhooks. */
export interface InstallResult {
	installation: InstallationRecord;
	created: boolean;
	added: string[];
	removed: string[];
}

export interface CoveringEvent {
	/** `owner/name` */
	fullName: string;
	owner: string;
	event: string;
}

export interface Covering {
	app: AppRecord;
	installation: InstallationRecord;
}

export const repoCovered = (i: InstallationRecord, fullName: string, owner: string) =>
	!i.suspended &&
	(i.repositorySelection === 'all'
		? i.account.toLowerCase() === owner.toLowerCase()
		: i.repos.includes(fullName.toLowerCase()));

const MAX_DELIVERIES = 10_000;

export const appsChart = statechart<AppsData>({ family: 'apps', revision: 'v1' })
	.dataExpression('apps', () => [])
	.dataExpression('codes', () => ({}))
	.dataExpression('installations', () => [])
	.dataExpression('tokens', () => ({}))
	.dataExpression('deliveries', () => [])
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				APPS_EVENTS.create,
				answer<AppsData, CreateAppEvent>((d, e) => {
					let slug = e.app.slug;
					for (let n = 2; d.apps.some((a) => a.slug === slug); n++) slug = `${e.app.slug}-${n}`;
					const app = { ...e.app, slug };
					d.apps.push(app);
					d.codes[e.code] = { appId: app.id, pem: e.pem, expiresAt: e.now + 3_600_000 };
					return app;
				})
			)
			.on(
				APPS_EVENTS.convert,
				answer<AppsData, { code: string; now: number }>((d, e) => {
					const c = d.codes[e.code];
					delete d.codes[e.code];
					if (!c || c.expiresAt < e.now) return fail(404, 'Not Found');
					const app = d.apps.find((a) => a.id === c.appId);
					if (!app) return fail(404, 'Not Found');
					return { app, pem: c.pem };
				})
			)
			.on(
				APPS_EVENTS.find,
				answer<AppsData, FindAppEvent>(
					(d, e) =>
						d.apps.find(
							(a) =>
								(e.id !== undefined && a.id === e.id) ||
								(e.clientId !== undefined && a.clientId === e.clientId) ||
								(e.slug !== undefined && a.slug === e.slug)
						) ?? null
				)
			)
			.on(
				APPS_EVENTS.install,
				answer<AppsData, InstallEvent>((d, e): InstallResult | ActorFailure => {
					if (!d.apps.some((a) => a.id === e.appId)) return fail(404, `Unknown app ${e.appId}`);
					const repos = e.selection === 'all' ? [] : [...new Set(e.repos.map((r) => r.toLowerCase()))].sort();
					const existing = d.installations.find(
						(i) => i.appId === e.appId && i.account.toLowerCase() === e.account.toLowerCase()
					);
					if (!existing) {
						const installation: InstallationRecord = {
							id: e.newId,
							appId: e.appId,
							account: e.account,
							accountId: e.accountId,
							accountType: e.accountType,
							repositorySelection: e.selection,
							repos,
							suspended: false,
							createdAt: e.now,
							permissions: { ...(d.apps.find((a) => a.id === e.appId)?.permissions ?? {}) },
							events: [...(d.apps.find((a) => a.id === e.appId)?.events ?? [])]
						};
						d.installations.push(installation);
						return { installation, created: true, added: repos, removed: [] };
					}
					const before = existing.repos;
					const added = repos.filter((r) => !before.includes(r));
					const removed = existing.repositorySelection === 'selected' ? before.filter((r) => !repos.includes(r)) : [];
					existing.repositorySelection = e.selection;
					existing.repos = repos;
					existing.accountType = e.accountType;
					return { installation: existing, created: false, added, removed };
				})
			)
			.on(
				APPS_EVENTS.installations,
				answer<AppsData, { appId?: number; id?: number }>((d, e) =>
					d.installations.filter((i) => (e.appId === undefined || i.appId === e.appId) && (e.id === undefined || i.id === e.id))
				)
			)
			.on(
				APPS_EVENTS.createToken,
				answer<AppsData, { appId: number; installationId: number; token: string; expiresAt: number; now: number }>((d, e) => {
					const i = d.installations.find((x) => x.id === e.installationId && x.appId === e.appId);
					if (!i) return fail(404, 'Not Found');
					if (i.suspended) return fail(403, 'This installation has been suspended');
					// Forget expired tokens so the map stays small.
					for (const [t, v] of Object.entries(d.tokens)) if (v.expiresAt < e.now) delete d.tokens[t];
					d.tokens[e.token] = { installationId: i.id, expiresAt: e.expiresAt };
					return { token: e.token, expiresAt: e.expiresAt, installation: i };
				})
			)
			.on(
				APPS_EVENTS.resolveToken,
				answer<AppsData, { token: string; now: number }>((d, e) => {
					const t = d.tokens[e.token];
					if (!t || t.expiresAt <= e.now) return null;
					const installation = d.installations.find((i) => i.id === t.installationId);
					const app = installation && d.apps.find((a) => a.id === installation.appId);
					return installation && app ? { installation, app } : null;
				})
			)
			.on(
				APPS_EVENTS.covering,
				answer<AppsData, CoveringEvent>((d, e) => {
					const out: Covering[] = [];
					for (const installation of d.installations) {
						if (!repoCovered(installation, e.fullName, e.owner)) continue;
						const app = d.apps.find((a) => a.id === installation.appId);
						// Only events the installation accepted are delivered (ADR 0282).
						if (app && app.webhookActive && app.events.includes(e.event) && installation.events.includes(e.event)) out.push({ app, installation });
					}
					return out;
				})
			)
			.on(
				APPS_EVENTS.recordDelivery,
				answer<AppsData, { delivery: AppDeliveryRecord }>((d, e) => {
					d.deliveries.push(e.delivery);
					if (d.deliveries.length > MAX_DELIVERIES) d.deliveries.splice(0, d.deliveries.length - MAX_DELIVERIES);
					return e.delivery;
				})
			)
			.on(
				APPS_EVENTS.deliveries,
				answer<AppsData, { appId: number }>((d, e) => d.deliveries.filter((x) => x.appId === e.appId))
			)
			.on(
				APPS_EVENTS.setPermissions,
				answer<AppsData, { appId: number; permissions: Record<string, string>; events: string[] }>((d, e) => {
					const app = d.apps.find((a) => a.id === e.appId);
					if (!app) return fail(404, `Unknown app ${e.appId}`);
					app.permissions = { metadata: 'read', ...e.permissions };
					app.events = [...e.events];
					return app;
				})
			)
			.on(
				APPS_EVENTS.acceptPermissions,
				answer<AppsData, { installationId: number }>((d, e) => {
					const installation = d.installations.find((i) => i.id === e.installationId);
					const app = installation && d.apps.find((a) => a.id === installation.appId);
					if (!installation || !app) return fail(404, `Unknown installation ${e.installationId}`);
					installation.permissions = { ...app.permissions };
					installation.events = [...app.events];
					return { installation, app };
				})
			)
	);
