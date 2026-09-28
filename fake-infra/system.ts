/**
 * fake-infra's tinyactors System (ADR 0130): I/O processors, trace export,
 * singleton actors, bucket actors, reset and the state snapshot.
 */
import { createSystem, type System } from '@tinyactors/node';
import { REPLY_IO, rejectAllPending, replyProcessor } from './io/reply';
import { SETTINGS_ADDRESS, settingsChart, type SettingsData } from './actors/settings';
import { CREDENTIALS_ADDRESS, credentialsChart, type CredentialsData } from './actors/credentials';
import { FAULTS_ADDRESS, faultsChart, type FaultsData } from './actors/faults';
import { COLLECTOR_ADDRESS, collectorChart, type CollectorData } from './actors/collector';
import { BUCKET_FAMILY, bucketAddress, bucketChart, type BucketData, type Jurisdiction } from './actors/bucket';
import * as blobs from './blobs';
import type { FakeInfraState } from './schemas';
import type { InfraLog } from './events';

export interface FakeInfraOptions {
	/** OTEL_EXPORTER_OTLP_ENDPOINT (without /v1/traces), or null. */
	otlpEndpoint: string | null;
}

export function createInfraSystem(options: FakeInfraOptions) {
	const system: System = createSystem({ finished: 'destroy' });
	system.registerIO(REPLY_IO, replyProcessor);

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
			{ detail: 'decisions', values: false, resource: { 'service.name': 'fake-infra' } }
		);
	}

	const definitions = {
		settings: system.define(settingsChart),
		credentials: system.define(credentialsChart),
		faults: system.define(faultsChart),
		collector: system.define(collectorChart),
		bucket: system.define(bucketChart)
	};

	function spawnSingletons() {
		system.spawn(definitions.settings, { address: SETTINGS_ADDRESS });
		system.spawn(definitions.credentials, { address: CREDENTIALS_ADDRESS });
		system.spawn(definitions.faults, { address: FAULTS_ADDRESS });
		system.spawn(definitions.collector, { address: COLLECTOR_ADDRESS });
	}
	spawnSingletons();

	const residents = () => [...system.actors()];

	return {
		system,
		definitions,

		bucketExists: (name: string) => system.findActor(bucketAddress(name)) !== undefined,

		createBucket(name: string, jurisdiction: Jurisdiction, quotaBytes: number | null) {
			system.spawn(definitions.bucket, {
				address: bucketAddress(name),
				binding: { name, jurisdiction, quotaBytes, objects: {}, uploads: {}, lastWrite: {}, out: null }
			});
		},

		deleteBucket(name: string): boolean {
			const a = system.findActor(bucketAddress(name));
			if (!a) return false;
			const d = a.data() as unknown as BucketData;
			for (const o of Object.values(d.objects)) blobs.drop(o.blobId);
			for (const u of Object.values(d.uploads)) for (const p of Object.values(u.parts)) blobs.drop(p.blobId);
			system.destroy(a);
			return true;
		},

		/** Names of the buckets in one jurisdiction (ListBuckets for admin keys). */
		snapshotBucketNames(jurisdiction: Jurisdiction): string[] {
			return residents()
				.filter((a) => a.definition.family === BUCKET_FAMILY && (a.data as BucketData).jurisdiction === jurisdiction)
				.map((a) => (a.data as BucketData).name)
				.sort();
		},

		bucketInfo(name: string): { jurisdiction: Jurisdiction } | null {
			const a = system.findActor(bucketAddress(name));
			return a ? { jurisdiction: (a.data() as unknown as BucketData).jurisdiction } : null;
		},

		reset() {
			rejectAllPending('fake-infra was reset');
			for (const a of residents()) if (system.exists(a.actor)) system.destroy(a.actor);
			blobs.clear();
			spawnSingletons();
		},

		/** `GET /__control/state`, read from the actors' live data. */
		snapshot(log: InfraLog, exeProxy: FakeInfraState['exeProxy']): FakeInfraState {
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
			for (const a of residents()) {
				const family = a.definition.family;
				if (family === 'settings') {
					const d = a.data as SettingsData;
					state.fidelity = { ...d.fidelity };
					state.clockSkewMs = d.clockSkewMs;
				} else if (family === 'credentials') {
					state.credentials = (a.data as CredentialsData).creds.map((c) => ({
						id: c.id,
						kind: c.kind,
						scope: c.scope,
						revoked: c.revoked,
						label: c.label ?? (c.kind === 's3' ? `${c.accessKeyId} → ${c.buckets.join(', ')}` : null)
					}));
				} else if (family === 'faults') {
					state.faults = (a.data as FaultsData).faults.map((f) => ({ ...f }));
				} else if (family === 'collector') {
					state.otlp = (a.data as CollectorData).batches.slice(-200).map((b) => ({ ...b, summary: [...b.summary] }));
				} else if (family === BUCKET_FAMILY) {
					const d = a.data as BucketData;
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
			}
			state.buckets.sort((x, y) => (x.name < y.name ? -1 : 1));
			return state;
		}
	};
}

export type InfraSystem = ReturnType<typeof createInfraSystem>;
