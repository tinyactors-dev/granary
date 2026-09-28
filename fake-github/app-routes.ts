/**
 * GitHub App endpoints of the fake (ADR 0164, ADR 0200), GitHub-compatible:
 *
 * - manifest flow: `POST /settings/apps/new` (+ `/organizations/{org}/…`),
 *   `POST /settings/apps/new/confirm`, `POST /app-manifests/{code}/conversions`
 * - app auth (RS256 JWT): `GET /app`, `GET /app/installations[/{id}]`,
 *   `POST /app/installations/{id}/access_tokens`, `GET /app/hook/deliveries[/{id}]`,
 *   `POST /app/hook/deliveries/{id}/attempts`
 * - installation token: `GET /installation/repositories`
 * - install UI: `GET /apps/{slug}/installations/new`, `POST …/confirm`
 * - control: `POST /__control/apps/{appId}/installations`, `POST /__control/apps/{appId}/auto-install`
 *
 * All data lives in the `apps/main` actor; this module does HTTP, crypto
 * and webhook fan-out.
 */
import type { System } from '@tinyactors/node';
import { AppAutoInstallRequest, InstallAppRequest, type FakeUser, type InstallAppResponse } from './schemas';
import { ask, isFailure } from './io/reply';
import { nextId } from './ids';
import { APPS_ADDRESS, APPS_EVENTS, repoCovered, type AppDeliveryRecord, type AppRecord, type InstallResult, type InstallationRecord } from './actors/apps';
import { generateAppKeyPair, looksLikeJwt, peekJwt, randomToken, verifyAppJwt } from './app-crypto';
import { installPage, manifestConfirmPage } from './app-pages';
import { userView, type Bases } from './views';
import type { DeliveryReply } from './actors/delivery';

export interface DeliveryTarget {
	url: string;
	secret: string;
	appId: number;
	installationId: number | null;
}

export interface AppRouteDeps {
	system: System;
	bases: Bases;
	ensureUser(login: string, type?: FakeUser['type']): Promise<FakeUser>;
	/** Ensure `owner/name` exists; returns the repo id. */
	ensureRepoId(owner: string, name: string): Promise<number>;
	/** All repos (`owner/name`, id) the fake knows. */
	repos(): { fullName: string; id: number; owner: string; name: string }[];
	deliverTo(target: DeliveryTarget, event: string, action: string, body: string, repoId: number | null): Promise<DeliveryReply>;
	/** Redeliver a delivery by guid (same body, same guid); null when unknown. */
	redeliver(guid: string): Promise<DeliveryReply | null>;
	validate<T>(schema: unknown, value: unknown, what: string): T;
	readJson(req: Request, opts?: { allowEmpty?: boolean }): Promise<unknown>;
	controlError(status: number, error: string): Response;
	json(body: unknown, status?: number, headers?: Record<string, string>): Response;
	githubError(status: number, message: string, extra?: Record<string, string>): Response;
}

/** ms; installation tokens live 1 h on GitHub. Tests shorten it (token refresh). */
const TOKEN_TTL_MS = Number(process.env.FAKE_GITHUB_INSTALLATION_TOKEN_TTL_MS ?? 3_600_000) || 3_600_000;

const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const slugify = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 34) || 'app';

async function formOrJson(req: Request): Promise<Record<string, string>> {
	const text = await req.text();
	const type = req.headers.get('content-type') ?? '';
	if (type.includes('application/json')) {
		try {
			return JSON.parse(text) as Record<string, string>;
		} catch {
			return {};
		}
	}
	return Object.fromEntries(new URLSearchParams(text));
}

export function createAppRoutes(deps: AppRouteDeps) {
	const { system, bases, json, githubError } = deps;

	const findApp = (q: { id?: number; clientId?: string; slug?: string }) =>
		ask<AppRecord | null>(system, APPS_ADDRESS, APPS_EVENTS.find, q);
	const installationsOf = (q: { appId?: number; id?: number }) =>
		ask<InstallationRecord[]>(system, APPS_ADDRESS, APPS_EVENTS.installations, q);

	// ---- views ---------------------------------------------------------------

	const appView = (a: AppRecord, installationsCount?: number) => ({
		id: a.id,
		slug: a.slug,
		node_id: `A_fake${a.id}`,
		name: a.name,
		description: a.description,
		external_url: a.url,
		html_url: `${bases.web}/apps/${a.slug}`,
		owner: { login: a.owner, id: a.ownerId, type: a.ownerType },
		client_id: a.clientId,
		permissions: a.permissions,
		events: a.events,
		created_at: iso(a.createdAt),
		updated_at: iso(a.createdAt),
		...(installationsCount !== undefined ? { installations_count: installationsCount } : {})
	});

	const installationView = (i: InstallationRecord, app: AppRecord) => ({
		id: i.id,
		app_id: i.appId,
		app_slug: app.slug,
		client_id: app.clientId,
		target_id: i.accountId,
		target_type: i.accountType,
		account: { login: i.account, id: i.accountId, type: i.accountType, node_id: `U_fake${i.accountId}` },
		repository_selection: i.repositorySelection,
		access_tokens_url: `${bases.api}/app/installations/${i.id}/access_tokens`,
		repositories_url: `${bases.api}/installation/repositories`,
		html_url: `${bases.web}/settings/installations/${i.id}`,
		permissions: app.permissions,
		events: app.events,
		created_at: iso(i.createdAt),
		updated_at: iso(i.createdAt),
		suspended_at: i.suspended ? iso(i.createdAt) : null,
		suspended_by: null
	});

	const repoView = (r: { id: number; fullName: string; name: string; owner: string }) => ({
		id: r.id,
		node_id: `R_fake${r.id}`,
		name: r.name,
		full_name: r.fullName,
		private: false,
		owner: { login: r.owner },
		html_url: `${bases.web}/${r.fullName}`
	});

	const reposOf = (i: InstallationRecord) =>
		deps.repos().filter((r) => repoCovered(i, r.fullName, r.owner));

	const deliveryView = (d: AppDeliveryRecord) => ({
		id: d.id,
		guid: d.guid,
		delivered_at: iso(d.deliveredAt),
		redelivery: d.redelivery,
		duration: d.durationMs / 1000,
		status: d.statusCode === 0 ? 'failed to connect to host' : d.statusCode >= 200 && d.statusCode < 300 ? 'OK' : `Invalid HTTP Response: ${d.statusCode}`,
		status_code: d.statusCode,
		event: d.event,
		action: d.action,
		installation_id: d.installationId,
		repository_id: d.repositoryId,
		throttled_at: null
	});

	// ---- auth ------------------------------------------------------------------

	/** The app a request's JWT authenticates, or a 401 Response. */
	async function appFromJwt(req: Request): Promise<AppRecord | Response> {
		const h = req.headers.get('authorization') ?? '';
		const m = /^bearer\s+(\S+)\s*$/i.exec(h);
		if (!m) return githubError(401, 'A JSON web token could not be decoded');
		const token = m[1]!;
		if (!looksLikeJwt(token)) return githubError(401, 'A JSON web token could not be decoded');
		const iss = peekJwt(token)?.claims.iss;
		const app =
			typeof iss === 'number' || (typeof iss === 'string' && /^\d+$/.test(iss))
				? await findApp({ id: Number(iss) })
				: typeof iss === 'string'
					? await findApp({ clientId: iss })
					: null;
		if (!app) return githubError(401, "'Issuer' claim ('iss') must be an Integer");
		const check = verifyAppJwt(token, app.publicKeyPem);
		if (!check.ok) return githubError(401, check.message);
		return app;
	}

	// ---- webhooks --------------------------------------------------------------

	async function sendInstallationEvents(app: AppRecord, r: InstallResult, sender: FakeUser): Promise<DeliveryReply> {
		const target: DeliveryTarget = { url: app.webhookUrl, secret: app.webhookSecret, appId: app.id, installationId: r.installation.id };
		const inst = installationView(r.installation, app);
		const senderView = userView(sender, bases);
		const repoBy = (full: string) => deps.repos().find((x) => x.fullName.toLowerCase() === full)!;
		if (r.created) {
			const repositories = reposOf(r.installation).map(repoView);
			return deps.deliverTo(target, 'installation', 'created', JSON.stringify({ action: 'created', installation: inst, repositories, sender: senderView }), null);
		}
		const body = {
			action: r.added.length || !r.removed.length ? 'added' : 'removed',
			installation: inst,
			repository_selection: r.installation.repositorySelection,
			repositories_added: r.added.map(repoBy).filter(Boolean).map(repoView),
			repositories_removed: r.removed.map(repoBy).filter(Boolean).map(repoView),
			sender: senderView
		};
		return deps.deliverTo(target, 'installation_repositories', body.action, JSON.stringify(body), null);
	}

	/** Create or update an installation (UI confirm and control API share this). */
	async function install(app: AppRecord, account: string, accountType: 'User' | 'Organization', repos: string[] | undefined) {
		const accountUser = await deps.ensureUser(account);
		for (const full of repos ?? []) {
			const [owner, name] = full.split('/') as [string, string];
			await deps.ensureRepoId(owner, name);
		}
		const result = await ask<InstallResult>(system, APPS_ADDRESS, APPS_EVENTS.install, {
			appId: app.id,
			newId: nextId(),
			account: accountUser.login,
			accountId: accountUser.id,
			accountType,
			selection: repos ? 'selected' : 'all',
			repos: repos ?? [],
			now: Date.now()
		});
		if (isFailure(result)) throw new Error(result.error);
		const reply = await sendInstallationEvents(app, result, accountUser);
		return { result, reply };
	}

	// ---- manifest flow -----------------------------------------------------------

	async function manifestNew(req: Request, url: URL, org: string | null): Promise<Response> {
		const form = await formOrJson(req);
		const raw = form.manifest;
		if (!raw) return new Response('manifest is required', { status: 400 });
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return new Response('manifest must be JSON', { status: 400 });
		}
		const missing = ['name', 'url', 'redirect_url'].filter((k) => typeof manifest[k] !== 'string');
		const hook = manifest.hook_attributes as { url?: unknown } | undefined;
		if (typeof hook?.url !== 'string') missing.push('hook_attributes.url');
		if (missing.length) return new Response(`Invalid manifest: missing ${missing.join(', ')}`, { status: 422 });
		const state = url.searchParams.get('state') ?? form.state ?? '';
		const owner = org ?? url.searchParams.get('login') ?? form.login ?? 'admin';
		const ownerType = org ? 'Organization' : 'User';
		if (url.searchParams.get('auto') === '1' || form.auto === '1') return createFromManifest(raw, state, owner, ownerType);
		return html(
			manifestConfirmPage({
				manifestJson: raw,
				name: String(manifest.name),
				owner,
				ownerType,
				state,
				permissions: (manifest.default_permissions as Record<string, string>) ?? {},
				events: (manifest.default_events as string[]) ?? []
			})
		);
	}

	async function manifestConfirm(req: Request): Promise<Response> {
		const form = await formOrJson(req);
		if (!form.manifest || !form.owner) return new Response('manifest and owner are required', { status: 400 });
		return createFromManifest(form.manifest, form.state ?? '', form.owner, form.owner_type === 'Organization' ? 'Organization' : 'User');
	}

	async function createFromManifest(raw: string, state: string, ownerLogin: string, ownerType: 'User' | 'Organization') {
		const m = JSON.parse(raw) as {
			name: string;
			url: string;
			description?: string;
			hook_attributes: { url: string; active?: boolean };
			redirect_url: string;
			callback_urls?: string[];
			setup_url?: string;
			default_permissions?: Record<string, string>;
			default_events?: string[];
		};
		const owner = await deps.ensureUser(ownerLogin, ownerType === 'Organization' ? 'Organization' : undefined);
		const keys = generateAppKeyPair();
		const code = randomToken('');
		const app: AppRecord = {
			id: nextId(),
			slug: slugify(m.name),
			name: m.name,
			owner: owner.login,
			ownerId: owner.id,
			ownerType,
			clientId: `Iv23fake${randomToken('').slice(0, 12)}`,
			clientSecret: randomToken('').padEnd(40, '0').slice(0, 40),
			webhookSecret: randomToken('whsec_'),
			publicKeyPem: keys.publicKeyPem,
			webhookUrl: m.hook_attributes.url,
			webhookActive: m.hook_attributes.active !== false,
			redirectUrl: m.redirect_url,
			setupUrl: m.setup_url ?? null,
			callbackUrls: m.callback_urls ?? [],
			url: m.url,
			description: m.description ?? '',
			permissions: { metadata: 'read', ...(m.default_permissions ?? {}) },
			events: m.default_events ?? [],
			createdAt: Date.now()
		};
		await ask(system, APPS_ADDRESS, APPS_EVENTS.create, { app, code, pem: keys.privateKeyPem, now: Date.now() });
		const target = new URL(m.redirect_url);
		target.searchParams.set('code', code);
		if (state) target.searchParams.set('state', state);
		return redirect(target.toString());
	}

	async function conversion(code: string): Promise<Response> {
		const r = await ask<{ app: AppRecord; pem: string } | { error: string; status: number }>(system, APPS_ADDRESS, APPS_EVENTS.convert, {
			code,
			now: Date.now()
		});
		if (isFailure(r)) return githubError(404, 'Not Found');
		const { app, pem } = r as { app: AppRecord; pem: string };
		return json(
			{
				...appView(app),
				client_secret: app.clientSecret,
				webhook_secret: app.webhookSecret,
				pem
			},
			201
		);
	}

	// ---- install UI ----------------------------------------------------------------

	async function installNew(url: URL, slug: string): Promise<Response> {
		const app = await findApp({ slug });
		if (!app) return githubError(404, 'Not Found');
		const account = url.searchParams.get('account') ?? app.owner;
		const state = url.searchParams.get('state');
		if (url.searchParams.get('auto') === '1') {
			const reposParam = url.searchParams.get('repos');
			return installAndRedirect(app, account, reposParam ? reposParam.split(',').filter(Boolean) : undefined, state);
		}
		const knownRepos = deps.repos().filter((r) => r.owner.toLowerCase() === account.toLowerCase()).map((r) => r.fullName);
		return html(installPage({ slug: app.slug, name: app.name, account, state, knownRepos }));
	}

	async function installConfirm(req: Request, slug: string): Promise<Response> {
		const app = await findApp({ slug });
		if (!app) return githubError(404, 'Not Found');
		const form = await formOrJson(req);
		if (!form.account) return new Response('account is required', { status: 400 });
		const repos =
			form.selection === 'selected'
				? (form.repos ?? '')
						.split(/[\s,]+/)
						.map((s) => s.trim())
						.filter((s) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s))
				: undefined;
		return installAndRedirect(app, form.account, repos, form.state ?? null);
	}

	async function installAndRedirect(app: AppRecord, account: string, repos: string[] | undefined, state: string | null) {
		const { result } = await install(app, account, 'User', repos);
		const target = new URL(app.setupUrl ?? `${bases.web}/apps/${app.slug}`);
		target.searchParams.set('installation_id', String(result.installation.id));
		target.searchParams.set('setup_action', result.created ? 'install' : 'update');
		if (state) target.searchParams.set('state', state);
		return redirect(target.toString());
	}

	// ---- app-authenticated REST ------------------------------------------------------

	async function appApi(req: Request, path: string, url: URL): Promise<Response> {
		const app = await appFromJwt(req);
		if (app instanceof Response) return app;

		if (path === '/app' && req.method === 'GET') {
			return json(appView(app, (await installationsOf({ appId: app.id })).length));
		}
		if (path === '/app/installations' && req.method === 'GET') {
			return json((await installationsOf({ appId: app.id })).map((i) => installationView(i, app)));
		}
		const one = /^\/app\/installations\/(\d+)$/.exec(path);
		if (one && req.method === 'GET') {
			const [i] = await installationsOf({ appId: app.id, id: Number(one[1]) });
			return i ? json(installationView(i, app)) : githubError(404, 'Not Found');
		}
		const tok = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
		if (tok && req.method === 'POST') {
			const now = Date.now();
			const expiresAt = now + TOKEN_TTL_MS;
			const r = await ask<{ token: string; expiresAt: number; installation: InstallationRecord } | { error: string; status: number }>(
				system,
				APPS_ADDRESS,
				APPS_EVENTS.createToken,
				{ appId: app.id, installationId: Number(tok[1]), token: randomToken('ghs_'), expiresAt, now }
			);
			if (isFailure(r)) return githubError(r.status, r.error);
			const ok = r as { token: string; expiresAt: number; installation: InstallationRecord };
			return json(
				{
					token: ok.token,
					expires_at: iso(ok.expiresAt),
					permissions: app.permissions,
					repository_selection: ok.installation.repositorySelection
				},
				201
			);
		}
		if (path === '/app/hook/deliveries' && req.method === 'GET') {
			const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? 30) || 30, 1), 100);
			const cursor = Number(url.searchParams.get('cursor') ?? 0) || Infinity;
			const all = (await ask<AppDeliveryRecord[]>(system, APPS_ADDRESS, APPS_EVENTS.deliveries, { appId: app.id }))
				.filter((d) => d.id < cursor)
				.sort((a, b) => b.id - a.id);
			const page = all.slice(0, perPage);
			const headers: Record<string, string> = {};
			if (all.length > perPage) {
				const next = new URL(`${bases.api}/app/hook/deliveries`);
				next.searchParams.set('per_page', String(perPage));
				next.searchParams.set('cursor', String(page[page.length - 1]!.id));
				headers.Link = `<${next}>; rel="next"`;
			}
			return json(page.map(deliveryView), 200, headers);
		}
		const del = /^\/app\/hook\/deliveries\/(\d+)(\/attempts)?$/.exec(path);
		if (del) {
			const entry = (await ask<AppDeliveryRecord[]>(system, APPS_ADDRESS, APPS_EVENTS.deliveries, { appId: app.id })).find(
				(d) => d.id === Number(del[1])
			);
			if (!entry) return githubError(404, 'Not Found');
			if (!del[2] && req.method === 'GET') return json(deliveryView(entry));
			if (del[2] && req.method === 'POST') {
				// GitHub answers 202 and redelivers asynchronously.
				void deps.redeliver(entry.guid).catch((e) => console.error('[fake-github] redelivery failed', e));
				return json({}, 202);
			}
		}
		return githubError(404, 'Not Found');
	}

	async function installationRepos(installation: InstallationRecord): Promise<Response> {
		const repos = reposOf(installation).map(repoView);
		return json({ total_count: repos.length, repository_selection: installation.repositorySelection, repositories: repos });
	}

	// ---- control -------------------------------------------------------------------------

	/** Apps installed automatically on every account with repo activity (ADR 0230). */
	const autoInstall = new Set<number>();

	async function controlAutoInstall(req: Request, appId: number): Promise<Response> {
		const body = deps.validate<{ enabled: boolean }>(AppAutoInstallRequest, await deps.readJson(req), 'auto-install');
		const app = await findApp({ id: appId });
		if (!app) return deps.controlError(404, `Unknown app ${appId}`);
		if (body.enabled) autoInstall.add(appId);
		else autoInstall.delete(appId);
		return json({ ok: true });
	}

	/**
	 * Before a repo event is delivered: install every auto-install app on
	 * `owner` (all repos) if it is not installed there yet. The installation
	 * webhook goes out first, like on github.com.
	 */
	async function ensureAutoInstalled(owner: string): Promise<void> {
		for (const appId of autoInstall) {
			const app = await findApp({ id: appId });
			if (!app) {
				autoInstall.delete(appId);
				continue;
			}
			const installations = await installationsOf({ appId });
			if (installations.some((i) => i.account.toLowerCase() === owner.toLowerCase())) continue;
			await install(app, owner, 'User', undefined);
		}
	}

	const isAutoInstall = (appId: number) => autoInstall.has(appId);
	const resetAutoInstall = () => autoInstall.clear();

	async function controlInstall(req: Request, appId: number): Promise<Response> {
		const body = deps.validate<{ account: string; accountType?: 'User' | 'Organization'; repos?: string[] }>(
			InstallAppRequest,
			await deps.readJson(req),
			'installation'
		);
		const app = await findApp({ id: appId });
		if (!app) return deps.controlError(404, `Unknown app ${appId}`);
		const { result, reply } = await install(app, body.account, body.accountType ?? 'User', body.repos);
		return json({ installationId: result.installation.id, deliveryId: reply.deliveryId } satisfies InstallAppResponse);
	}

	/** Route; null when the path is not an app route. */
	async function route(req: Request, url: URL): Promise<Response | null> {
		const path = url.pathname;
		if (req.method === 'POST' && path === '/settings/apps/new') return manifestNew(req, url, null);
		const orgNew = /^\/organizations\/([^/]+)\/settings\/apps\/new$/.exec(path);
		if (req.method === 'POST' && orgNew) return manifestNew(req, url, decodeURIComponent(orgNew[1]!));
		if (req.method === 'POST' && path === '/settings/apps/new/confirm') return manifestConfirm(req);
		const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
		if (req.method === 'POST' && conv) {
			// Like github.com: the conversion is unauthenticated, and any Authorization header
			// that isn't a valid credential (e.g. an empty "Bearer ") is rejected.
			if (req.headers.has('authorization'))
				return Response.json({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' }, { status: 401 });
			return conversion(decodeURIComponent(conv[1]!));
		}
		const instNew = /^\/apps\/([^/]+)\/installations\/new(\/confirm)?$/.exec(path);
		if (instNew) {
			const slug = decodeURIComponent(instNew[1]!);
			if (!instNew[2] && req.method === 'GET') return installNew(url, slug);
			if (instNew[2] && req.method === 'POST') return installConfirm(req, slug);
		}
		if (path === '/app' || path.startsWith('/app/')) return appApi(req, path, url);
		const ctl = /^\/__control\/apps\/(\d+)\/installations$/.exec(path);
		if (req.method === 'POST' && ctl) return controlInstall(req, Number(ctl[1]));
		const auto = /^\/__control\/apps\/(\d+)\/auto-install$/.exec(path);
		if (req.method === 'POST' && auto) return controlAutoInstall(req, Number(auto[1]));
		return null;
	}

	return { route, installationRepos, findApp, ensureAutoInstalled, isAutoInstall, resetAutoInstall };
}

export type AppRoutes = ReturnType<typeof createAppRoutes>;
