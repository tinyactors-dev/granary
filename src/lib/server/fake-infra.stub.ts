/**
 * Canned fake-infra state for the StubBackend (ADR 0139): an EU bucket with a
 * few days of hourly backups (artifact + manifest pairs), an open multipart
 * upload, credentials, a live fault, OTLP batches and a request log. Control
 * actions mutate it in memory so the dev portal can be exercised offline.
 */
import type { FakeInfraAction, FakeInfraActionResult, FakeInfraInfo, FakeInfraStateValue } from '../schemas/dev';

const HOUR = 3_600_000;
const hex = (n: number) => Array.from({ length: n }, (_, i) => ((i * 7 + n) % 16).toString(16)).join('');

function seed(now: number): FakeInfraStateValue {
	const objects: FakeInfraStateValue['buckets'][number]['objects'] = [];
	for (let h = 0; h < 30; h++) {
		const at = now - h * HOUR;
		const d = new Date(at);
		const p = (n: number) => String(n).padStart(2, '0');
		const key = `granary/main/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/run_${(1000 - h).toString(36)}.sqlite.zst.aesgcm`;
		objects.push({ key, size: 18_400_000 + h * 1_300, etag: `${hex(32)}-3`, lastModified: at });
		objects.push({ key: `${key}.manifest.json`, size: 1_180, etag: hex(32), lastModified: at + 900 });
	}
	objects.sort((a, b) => (a.key < b.key ? -1 : 1));
	const usedBytes = objects.reduce((n, o) => n + o.size, 0);
	return {
		buckets: [
			{
				name: 'granary-backups',
				jurisdiction: 'eu',
				quotaBytes: 8 * 1024 ** 3,
				usedBytes,
				objects,
				multipartUploads: [{ uploadId: 'a1b2c3d4e5f6', key: 'granary/main/in-flight.sqlite.zst.aesgcm', parts: 2, initiatedAt: now - 40_000 }]
			},
			{ name: 'granary-scratch', jurisdiction: 'default', quotaBytes: 100_000, usedBytes: 0, objects: [], multipartUploads: [] }
		],
		credentials: [
			{ id: 'cred_seed01', kind: 's3', scope: 'object-rw', revoked: false, label: '0000…dev1 → granary-backups' },
			{ id: 'cred_old002', kind: 's3', scope: 'object-rw', revoked: true, label: '9f3a…77c1 → granary-backups' },
			{ id: 'cred_exe003', kind: 'exe-vm-token', scope: null, revoked: false, label: 'seed' }
		],
		faults: [{ id: 'fault_slow01', target: 's3', method: 'PUT', pathPattern: 'manifest\\.json', status: 503, s3Code: 'SlowDown', count: 3, remaining: 1, retryAfterSec: 2 }],
		fidelity: { sigV4: true, regionAuto: true, conditionalWrites: true, conditionalOnPresigned: true, equalPartSizes: true, perKeyWriteRateLimit: false, r2NotImplemented: true },
		clockSkewMs: 0,
		exeProxy: { tokenPort: 4091, peerPort: 4092 },
		otlp: Array.from({ length: 12 }, (_, i) => ({
			at: now - i * 15_000,
			signal: (['traces', 'logs', 'metrics'] as const)[i % 3]!,
			contentType: 'application/x-protobuf',
			bytes: 2_000 + i * 173,
			service: i % 4 === 0 ? 'granary-ops' : 'granary',
			via: (['exe-peer', 'exe-token', 'direct'] as const)[i % 3]!,
			summary: i % 3 === 0 ? ['scxml.macrostep issue.opened', 'scxml.microstep allowlist.verdict'] : i % 3 === 1 ? ['INFO backup-run succeeded'] : ['ops_backup_age_seconds', 'ops_disk_free_bytes']
		})).reverse(),
		requests: Array.from({ length: 20 }, (_, i) => ({
			at: now - (20 - i) * 9_000,
			surface: i % 5 === 4 ? ('otlp' as const) : ('s3' as const),
			method: i % 5 === 4 ? 'POST' : i % 3 === 0 ? 'PUT' : 'GET',
			path: i % 5 === 4 ? '/v1/traces' : `/s3/eu/granary-backups/granary/main/run_${i}.sqlite.zst.aesgcm${i % 3 === 0 ? '?partNumber=1&uploadId=a1b2c3d4e5f6' : ''}`,
			status: i === 7 ? 503 : 200,
			bytesIn: i % 3 === 0 ? 8_388_608 : 0,
			credentialId: 'cred_seed01',
			faultId: i === 7 ? 'fault_slow01' : null
		})),
		counters: { s3Puts: 187, s3Deletes: 12, s3BytesIn: 1_104_331_776, otlpBatches: 5_310 }
	};
}

export class StubFakeInfra {
	#state = seed(Date.now());

	async info(): Promise<FakeInfraInfo> {
		return {
			url: 'http://localhost:4090',
			reachable: true,
			error: null,
			state: structuredClone(this.#state),
			exeTokenUrl: this.#state.exeProxy.tokenPort ? `http://localhost:${this.#state.exeProxy.tokenPort}` : null,
			exePeerUrl: this.#state.exeProxy.peerPort ? `http://localhost:${this.#state.exeProxy.peerPort}` : null
		};
	}

	async control(a: FakeInfraAction): Promise<FakeInfraActionResult> {
		const s = this.#state;
		const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
		switch (a.action) {
			case 'reset':
				this.#state = seed(Date.now());
				return { ok: true };
			case 'create-bucket':
				s.buckets.push({ name: a.bucket.name, jurisdiction: a.bucket.jurisdiction ?? 'default', quotaBytes: a.bucket.quotaBytes ?? null, usedBytes: 0, objects: [], multipartUploads: [] });
				return { ok: true };
			case 'delete-bucket':
				s.buckets = s.buckets.filter((b) => b.name !== a.name);
				return { ok: true };
			case 'issue-credential': {
				const c = a.credential;
				const credId = id('cred');
				if (c.kind === 's3') {
					const accessKeyId = crypto.randomUUID().replace(/-/g, '');
					s.credentials.push({ id: credId, kind: 's3', scope: c.scope, revoked: false, label: `${accessKeyId} → ${c.buckets.join(', ')}` });
					return { ok: true, issued: { id: credId, kind: 's3', accessKeyId, secretAccessKey: (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '') } };
				}
				s.credentials.push({ id: credId, kind: c.kind, scope: null, revoked: false, label: c.label });
				return { ok: true, issued: { id: credId, kind: c.kind, token: `${c.kind === 'exe-vm-token' ? 'exe' : 'otlp'}_${crypto.randomUUID().replace(/-/g, '')}` } };
			}
			case 'revoke-credential': {
				const c = s.credentials.find((x) => x.id === a.id);
				if (c) c.revoked = true;
				return { ok: true };
			}
			case 'inject-fault': {
				const faultId = id('fault');
				s.faults.push({ ...a.fault, id: faultId, remaining: a.fault.count });
				return { ok: true, faultId };
			}
			case 'clear-faults':
				s.faults = [];
				return { ok: true };
			case 'set-fidelity':
				s.fidelity = { ...s.fidelity, ...a.fidelity };
				return { ok: true };
			case 'set-clock':
				s.clockSkewMs = a.clock.skewMs;
				return { ok: true };
			case 'set-exe-proxy':
				s.exeProxy = { tokenPort: a.proxy.tokenMode ? 4091 : null, peerPort: a.proxy.peerMode ? 4092 : null };
				return { ok: true };
		}
	}
}
