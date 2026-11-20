/**
 * The fake GitHub's tinyactors host (ADR 0060): I/O processors, trace
 * export, singleton actors, reset and the state snapshot.
 */
import { compileCharts, Host } from '@tinyactors/node';
import { askActor, contextsOf, findActor, postOTLP, telemetryConfig } from '../src/lib/charts/runtime';
import { WEBHOOK_IO, webhookProcessor, type WebhookConfig } from './io/webhook';
import { REGISTRY_ADDRESS, REGISTRY_CHART, registryChart, type RegistryData } from './actors/registry';
import { FAULTS_ADDRESS, FAULTS_CHART, faultsChart, type FaultsData } from './actors/faults';
import { OAUTH_ADDRESS, OAUTH_CHART, oauthChart } from './actors/oauth';
import { REPOSITORY_FAMILY, commentView, issueView, repositoryAddress, repositoryChart, type RepositoryData } from './actors/repository';
import { DELIVERY_FAMILY, deliveryAddress, deliveryChart, type DeliveryData } from './actors/delivery';
import { APPS_ADDRESS, APPS_CHART, APPS_EVENTS, appsChart, type AppsData } from './actors/apps';
import { parseFakeState, type FakeDelivery, type FakeIssue, type FakeState } from './schemas';

export interface FakeSystemOptions {
	webhook?: WebhookConfig;
	/** FAKE_GITHUB_OTLP_ENDPOINT (without /v1/traces), or null. */
	otlpEndpoint: string | null;
	/** ADR 0200: the simulated webhook outage flag (reported in the snapshot). */
	outage?: () => boolean;
}

export function createFakeSystem(options: FakeSystemOptions) {
	/** Aborted at shutdown: webhook requests in flight stop. */
	const shutdown = new AbortController();
	const charts = compileCharts([registryChart, faultsChart, oauthChart, repositoryChart, deliveryChart, appsChart], {
		warningsAsErrors: true
	});
	const host = new Host(charts, {
		system: 'fake-github',
		ioProcessors: {
			[WEBHOOK_IO]: webhookProcessor({ ...options.webhook, outage: options.outage, signal: shutdown.signal })
		},
		...(options.otlpEndpoint
			? { config: telemetryConfig('fake-github', { values: true }), telemetry: postOTLP(options.otlpEndpoint) }
			: {}),
		onHandlerError: (error) => console.error('[fake-github] handler failed:', error),
		onError: (actor, error) => console.error('[fake-github] actor failed:', actor.id, error)
	});
	charts.close();
	if (options.otlpEndpoint) void host.traceConfigure({ detail: 'decisions' });

	function spawnSingletons(apps: AppsData['apps'] = []) {
		host.spawn(REGISTRY_CHART, { name: REGISTRY_ADDRESS });
		host.spawn(FAULTS_CHART, { name: FAULTS_ADDRESS });
		host.spawn(OAUTH_CHART, { name: OAUTH_ADDRESS });
		return host.spawn(APPS_CHART, {
			name: APPS_ADDRESS,
			params: { d: { apps, codes: {}, installations: [], tokens: {}, deliveries: [] } satisfies AppsData as never }
		});
	}
	spawnSingletons();

	const read = async <T,>(chart: string) => (await contextsOf(host, chart)).map((c) => c.variables.d as T);

	return {
		host,

		/** The registry's users and repos, sorted by id (cheaper than `snapshot`). */
		async registry(): Promise<{ users: RegistryData['users'][string][]; repos: RegistryData['repos'][string][] }> {
			const [d] = await read<RegistryData>(REGISTRY_CHART);
			return {
				users: Object.values(d?.users ?? {}).sort((x, y) => x.id - y.id),
				repos: Object.values(d?.repos ?? {}).sort((x, y) => x.id - y.id)
			};
		},

		/** The newest registered GitHub App's id, or null. */
		async newestAppId(): Promise<number | null> {
			const [d] = await read<AppsData>(APPS_CHART);
			return d?.apps.reduce<number | null>((m, a) => (m === null || a.id > m ? a.id : m), null) ?? null;
		},

		/** Spawn `repository/<id>` unless it is live. */
		ensureRepository(d: RepositoryData) {
			const name = repositoryAddress(d.id);
			if (!findActor(host, name)) host.spawn(REPOSITORY_FAMILY, { name, params: { d: d as never } });
		},

		repositoryExists: (repoId: number) => findActor(host, repositoryAddress(repoId)) !== undefined,

		/** Spawn `delivery/<id>` (its first attempt starts at once). */
		spawnDelivery(d: DeliveryData) {
			return host.spawn(DELIVERY_FAMILY, { name: deliveryAddress(d.id), params: { d: d as never } });
		},

		deliveryExists: (id: string) => findActor(host, deliveryAddress(id)) !== undefined,

		/**
		 * Terminate every actor and start over with empty singletons. With
		 * `keepApps`, registered GitHub Apps survive (their installations,
		 * tokens and deliveries do not) — so a granary connected to an app
		 * stays connected across test resets (ADR 0230). Waiting asks time out.
		 */
		async reset(opts: { keepApps?: boolean } = {}) {
			const apps = opts.keepApps ? ((await read<AppsData>(APPS_CHART))[0]?.apps ?? []) : [];
			for (const a of await host.actors()) a.terminate();
			const appsActor = spawnSingletons(apps);
			// One round trip (to the new actor: until the terminations are run, the
			// names still find the old ones), so what follows finds the new singletons.
			await askActor(host, appsActor, APPS_EVENTS.installations, { id: -1 });
		},

		/** Stop: abort webhook requests in flight and close the host. */
		close() {
			shutdown.abort();
			host.close();
		},

		/** `GET /__control/state`, read from the actors' live data. */
		async snapshot(): Promise<FakeState> {
			const state: FakeState = {
				users: [],
				repos: [],
				issues: [],
				deliveries: [],
				faults: [],
				apps: [],
				installations: [],
				appDeliveries: [],
				webhookOutage: options.outage?.() ?? false
			};
			for (const d of await read<RegistryData>(REGISTRY_CHART)) {
				state.users.push(...Object.values(d.users).map((u) => ({ ...u })));
				state.repos.push(...Object.values(d.repos).map((r) => ({ ...r })));
			}
			for (const d of await read<AppsData>(APPS_CHART)) {
				state.apps!.push(
					...d.apps.map((x) => ({
						id: x.id,
						slug: x.slug,
						name: x.name,
						owner: x.owner,
						clientId: x.clientId,
						webhookUrl: x.webhookUrl,
						redirectUrl: x.redirectUrl,
						setupUrl: x.setupUrl,
						callbackUrls: [...x.callbackUrls],
						permissions: { ...x.permissions },
						events: [...x.events],
						createdAt: x.createdAt
					}))
				);
				state.installations!.push(
					...d.installations.map((i) => ({
						id: i.id,
						appId: i.appId,
						account: i.account,
						accountType: i.accountType,
						repositorySelection: i.repositorySelection,
						repos: [...i.repos],
						suspended: i.suspended,
						createdAt: i.createdAt,
						permissions: { ...(i.permissions ?? {}) },
						events: [...(i.events ?? [])]
					}))
				);
				state.appDeliveries!.push(
					...d.deliveries.map((x) => ({
						id: x.id,
						appId: x.appId,
						guid: x.guid,
						event: x.event,
						action: x.action,
						deliveredAt: x.deliveredAt,
						redelivery: x.redelivery,
						statusCode: x.statusCode,
						installationId: x.installationId,
						repositoryId: x.repositoryId
					}))
				);
			}
			for (const d of await read<FaultsData>(FAULTS_CHART)) state.faults.push(...d.faults.map((f) => ({ ...f })));
			for (const d of await read<RepositoryData>(REPOSITORY_FAMILY)) {
				for (const i of d.issues) {
					const issue: FakeIssue = {
						...issueView(d, i),
						repoId: d.id,
						owner: d.owner,
						repo: d.name,
						comments: i.comments.map((c) => commentView(d, i, c)),
						...(i.pullRequest ? { pullRequest: { draft: i.pullRequest.draft } } : {})
					};
					state.issues.push(issue);
				}
			}
			const deliveries: (FakeDelivery & { createdAt: number })[] = [];
			for (const d of await read<DeliveryData>(DELIVERY_FAMILY)) {
				const row: FakeDelivery & { createdAt: number } = {
					id: d.id,
					event: d.event,
					action: d.action,
					status: d.status,
					responseCode: d.responseCode,
					attempts: d.attempts,
					lastAttemptAt: d.lastAttemptAt,
					createdAt: d.createdAt
				};
				if (d.repoId !== null) row.repoId = d.repoId;
				if (d.issueNumber !== null) row.issueNumber = d.issueNumber;
				deliveries.push(row);
			}
			deliveries.sort((x, y) => x.createdAt - y.createdAt);
			state.deliveries = deliveries.map(({ createdAt: _c, ...rest }) => rest);
			state.users.sort((x, y) => x.id - y.id);
			state.repos.sort((x, y) => x.id - y.id);
			state.apps!.sort((x, y) => x.id - y.id);
			state.installations!.sort((x, y) => x.id - y.id);
			state.appDeliveries!.sort((x, y) => x.id - y.id);
			state.issues.sort((x, y) => x.repoId - y.repoId || x.number - y.number);
			return parseFakeState(state);
		}
	};
}

export type FakeSystem = ReturnType<typeof createFakeSystem>;
