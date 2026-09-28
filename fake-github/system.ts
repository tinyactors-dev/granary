/**
 * The fake GitHub's tinyactors System (ADR 0060): I/O processors, trace
 * export, singleton actors, reset and the state snapshot.
 */
import { createSystem, type System } from '@tinyactors/node';
import { REPLY_IO, rejectAllPending, replyProcessor } from './io/reply';
import { WEBHOOK_IO, webhookProcessor, type WebhookConfig } from './io/webhook';
import { REGISTRY_ADDRESS, registryChart, type RegistryData } from './actors/registry';
import { FAULTS_ADDRESS, faultsChart, type FaultsData } from './actors/faults';
import { OAUTH_ADDRESS, oauthChart } from './actors/oauth';
import { REPOSITORY_FAMILY, commentView, issueView, repositoryChart, type RepositoryData } from './actors/repository';
import { DELIVERY_FAMILY, deliveryChart, type DeliveryData } from './actors/delivery';
import { parseFakeState, type FakeDelivery, type FakeIssue, type FakeState } from './schemas';

export interface FakeSystemOptions {
	webhook: WebhookConfig;
	/** OTEL_EXPORTER_OTLP_ENDPOINT (without /v1/traces), or null. */
	otlpEndpoint: string | null;
}

export function createFakeSystem(options: FakeSystemOptions) {
	const system: System = createSystem({ finished: 'destroy' });
	system.registerIO(REPLY_IO, replyProcessor);
	system.registerIO(WEBHOOK_IO, webhookProcessor(options.webhook));

	if (options.otlpEndpoint) {
		const base = options.otlpEndpoint.replace(/\/+$/, '');
		const post = (path: string, bytes: Uint8Array) =>
			fetch(`${base}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-protobuf' },
				body: bytes as Uint8Array<ArrayBuffer>
			}).catch(() => undefined);
		system.setTraceSink(
			(traces, logs) => {
				if (traces.byteLength) void post('/v1/traces', traces);
				if (logs?.byteLength) void post('/v1/logs', logs);
			},
			{ detail: 'decisions', values: true, resource: { 'service.name': 'fake-github' } }
		);
	}

	const definitions = {
		registry: system.define(registryChart),
		faults: system.define(faultsChart),
		oauth: system.define(oauthChart),
		repository: system.define(repositoryChart),
		delivery: system.define(deliveryChart)
	};

	function spawnSingletons() {
		system.spawn(definitions.registry, { address: REGISTRY_ADDRESS });
		system.spawn(definitions.faults, { address: FAULTS_ADDRESS });
		system.spawn(definitions.oauth, { address: OAUTH_ADDRESS });
	}
	spawnSingletons();

	function residents() {
		return [...system.actors()];
	}

	return {
		system,
		definitions,

		/** Destroy every actor and start over with empty singletons. */
		reset() {
			rejectAllPending('fake GitHub was reset');
			for (const a of residents()) {
				if (system.exists(a.actor)) system.destroy(a.actor);
			}
			spawnSingletons();
		},

		/** `GET /__control/state`, read from the actors' live data. */
		snapshot(): FakeState {
			const state: FakeState = { users: [], repos: [], issues: [], deliveries: [], faults: [] };
			const deliveries: (FakeDelivery & { createdAt: number })[] = [];
			for (const a of residents()) {
				const family = a.definition.family;
				if (family === 'registry') {
					const d = a.data as RegistryData;
					state.users.push(...Object.values(d.users).map((u) => ({ ...u })));
					state.repos.push(...Object.values(d.repos).map((r) => ({ ...r })));
				} else if (family === 'faults') {
					state.faults.push(...(a.data as FaultsData).faults.map((f) => ({ ...f })));
				} else if (family === REPOSITORY_FAMILY) {
					const d = a.data as RepositoryData;
					for (const i of d.issues) {
						const issue: FakeIssue = {
							...issueView(d, i),
							repoId: d.id,
							owner: d.owner,
							repo: d.name,
							comments: i.comments.map((c) => commentView(d, i, c))
						};
						state.issues.push(issue);
					}
				} else if (family === DELIVERY_FAMILY) {
					const d = a.data as DeliveryData;
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
			}
			deliveries.sort((x, y) => x.createdAt - y.createdAt);
			state.deliveries = deliveries.map(({ createdAt: _c, ...rest }) => rest);
			state.users.sort((x, y) => x.id - y.id);
			state.repos.sort((x, y) => x.id - y.id);
			state.issues.sort((x, y) => x.repoId - y.repoId || x.number - y.number);
			return parseFakeState(state);
		}
	};
}

export type FakeSystem = ReturnType<typeof createFakeSystem>;
