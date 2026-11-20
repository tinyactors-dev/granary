/**
 * fake-infra's tinyactors host (ADR 0130): I/O processors, trace export,
 * singleton actors, bucket actors, reset and the state snapshot.
 */
import { compileCharts, Host } from '@tinyactors/node';
import { contextsOf, findActor, postOTLP, telemetryConfig } from '../src/lib/charts/runtime';
import { SETTINGS_ADDRESS, settingsChart, type SettingsData } from './actors/settings';
import { CREDENTIALS_ADDRESS, credentialsChart, type CredentialsData } from './actors/credentials';
import { FAULTS_ADDRESS, faultsChart, type FaultsData } from './actors/faults';
import { COLLECTOR_ADDRESS, collectorChart, type CollectorData } from './actors/collector';
import { BUCKET_FAMILY, bucketAddress, bucketChart, type BucketData, type Jurisdiction } from './actors/bucket';
import * as blobs from './blobs';
import type { FakeInfraState } from './schemas';
import type { InfraLog } from './events';

export interface FakeInfraOptions {
	/** FAKE_INFRA_OTLP_ENDPOINT (without /v1/traces), or null. */
	otlpEndpoint: string | null;
}

export function createInfraSystem(options: FakeInfraOptions) {
	const charts = compileCharts([settingsChart, credentialsChart, faultsChart, collectorChart, bucketChart], { warningsAsErrors: true });
	const host = new Host(charts, {
		system: 'fake-infra',
		...(options.otlpEndpoint
			? { config: telemetryConfig('fake-infra'), telemetry: postOTLP(options.otlpEndpoint) }
			: {}),
		onHandlerError: (error) => console.error('[fake-infra] handler failed:', error)
	});
	charts.close();
	if (options.otlpEndpoint) void host.traceConfigure({ detail: 'decisions' });

	function spawnSingletons() {
		host.spawn('settings', { name: SETTINGS_ADDRESS });
		host.spawn('credentials', { name: CREDENTIALS_ADDRESS });
		host.spawn('faults', { name: FAULTS_ADDRESS });
		host.spawn('collector', { name: COLLECTOR_ADDRESS });
	}
	spawnSingletons();

	const bucketData = async (name: string): Promise<BucketData | null> => {
		const a = findActor(host, bucketAddress(name));
		return a ? ((await a.context()).variables.d as BucketData) : null;
	};

	return {
		host,

		bucketExists: (name: string) => findActor(host, bucketAddress(name)) !== undefined,

		createBucket(name: string, jurisdiction: Jurisdiction, quotaBytes: number | null) {
			host.spawn(BUCKET_FAMILY, {
				name: bucketAddress(name),
				params: { d: { name, jurisdiction, quotaBytes, objects: {}, uploads: {}, lastWrite: {} } }
			});
		},

		async deleteBucket(name: string): Promise<boolean> {
			const d = await bucketData(name);
			const a = findActor(host, bucketAddress(name));
			if (!d || !a) return false;
			for (const o of Object.values(d.objects)) blobs.drop(o.blobId);
			for (const u of Object.values(d.uploads)) for (const p of Object.values(u.parts)) blobs.drop(p.blobId);
			a.terminate();
			return true;
		},

		/** Names of the buckets in one jurisdiction (ListBuckets for admin keys). */
		async snapshotBucketNames(jurisdiction: Jurisdiction): Promise<string[]> {
			return (await contextsOf(host, BUCKET_FAMILY))
				.map((c) => c.variables.d as BucketData)
				.filter((d) => d.jurisdiction === jurisdiction)
				.map((d) => d.name)
				.sort();
		},

		async bucketInfo(name: string): Promise<{ jurisdiction: Jurisdiction } | null> {
			const d = await bucketData(name);
			return d ? { jurisdiction: d.jurisdiction } : null;
		},

		async reset() {
			for (const a of await host.actors()) a.terminate();
			blobs.clear();
			spawnSingletons();
		},

		/** `GET /__control/state`, read from the actors' live data. */
		async snapshot(log: InfraLog, exeProxy: FakeInfraState['exeProxy']): Promise<FakeInfraState> {
			const state: FakeInfraState = {
				buckets: [],
				credentials: [],
				faults: [],
				fidelity: {
					sigV4: true,
					regionAuto: true,
					conditionalWrites: true,
					conditionalOnPresigned: true,
					equalPartSizes: true,
					perKeyWriteRateLimit: false,
					r2NotImplemented: true
				},
				clockSkewMs: 0,
				exeProxy,
				otlp: [],
				requests: log.requests.slice(-500),
				counters: { ...log.counters }
			};
			const read = async (chart: string) => (await contextsOf(host, chart)).map((c) => c.variables.d);
			const [settings] = (await read('settings')) as SettingsData[];
			if (settings) {
				state.fidelity = { ...settings.fidelity };
				state.clockSkewMs = settings.clockSkewMs;
			}
			const [credentials] = (await read('credentials')) as CredentialsData[];
			if (credentials)
				state.credentials = credentials.creds.map((c) => ({
					id: c.id,
					kind: c.kind,
					scope: c.scope,
					revoked: c.revoked,
					label: c.label ?? (c.kind === 's3' ? `${c.accessKeyId} → ${c.buckets.join(', ')}` : null)
				}));
			const [faults] = (await read('faults')) as FaultsData[];
			if (faults) state.faults = faults.faults.map((f) => ({ ...f }));
			const [collector] = (await read('collector')) as CollectorData[];
			if (collector) state.otlp = collector.batches.slice(-200).map((b) => ({ ...b, summary: [...b.summary] }));
			for (const d of (await read(BUCKET_FAMILY)) as BucketData[]) {
				const objects = Object.values(d.objects)
					.map((o) => ({ key: o.key, size: o.size, etag: o.etag, lastModified: o.lastModified }))
					.sort((x, y) => (x.key < y.key ? -1 : 1));
				state.buckets.push({
					name: d.name,
					jurisdiction: d.jurisdiction,
					quotaBytes: d.quotaBytes,
					usedBytes: objects.reduce((n, o) => n + o.size, 0),
					objects,
					multipartUploads: Object.values(d.uploads).map((u) => ({
						uploadId: u.uploadId,
						key: u.key,
						parts: Object.keys(u.parts).length,
						initiatedAt: u.initiatedAt
					}))
				});
			}
			state.buckets.sort((x, y) => (x.name < y.name ? -1 : 1));
			return state;
		}
	};
}

export type InfraSystem = ReturnType<typeof createInfraSystem>;
