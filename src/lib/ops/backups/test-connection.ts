/**
 * Test connection for a destination (ADR 0095, 0106): PUT probe → HEAD →
 * LIST prefix → GET + compare → conditional PUT (expect 412) → DELETE → HEAD
 * (expect 404). Each step reports ok/duration/provider code; advisories are
 * manual checks an object-scoped token can't verify.
 */
import type { TestConnectionResult, TestStep } from '../schemas/api';
import { PROBE_PREFIX, type DestinationSettings } from '../schemas/destinations';
import { newId } from './repo';
import { StoreFailure, openStore, type BackupStore } from './stores';

const R2_ADVISORIES = [
	{ title: 'Keep the default multipart cleanup rule', detail: 'R2 buckets expire incomplete multipart uploads after 7 days by default (Settings → Object lifecycle rules). Keep it: interrupted uploads are cleaned up by it.', docsUrl: 'https://developers.cloudflare.com/r2/buckets/object-lifecycles/' },
	{ title: 'No lifecycle rule may delete under this prefix', detail: 'Retention is managed by granary (GFS schedule + hard caps); a bucket rule would delete backups behind its back.', docsUrl: null },
	{ title: 'Token scope', detail: 'Use an R2 API token with "Object Read & Write" for this bucket only — no Admin permissions. R2 has no versioning/object lock, so the token scope is the protection against deletion.', docsUrl: 'https://developers.cloudflare.com/r2/api/tokens/' },
	{ title: 'EU jurisdiction', detail: 'The bucket must be created in the European Union jurisdiction; its S3 endpoint then contains ".eu.". The jurisdiction cannot be changed after creation.', docsUrl: 'https://developers.cloudflare.com/r2/reference/data-location/' }
];
const S3_ADVISORIES = [
	{ title: 'Abort incomplete multipart uploads', detail: 'Add a bucket lifecycle rule AbortIncompleteMultipartUpload ≤ 7 days: Bun’s S3 client cannot list or abort abandoned multipart uploads.', docsUrl: null },
	{ title: 'No lifecycle rule may delete under this prefix', detail: 'Retention is managed by granary (GFS schedule + hard caps).', docsUrl: null }
];

export async function testDestination(opts: {
	settings: DestinationSettings;
	secret: (ref: string) => Promise<string>;
	dataDir: string;
	now: () => number;
	onEgress?: (bytes: number) => void;
}): Promise<TestConnectionResult> {
	const steps: TestStep[] = [];
	let store: BackupStore | null = null;
	let endpoint: string | null = null;
	try {
		store = await openStore(opts.settings, { secret: opts.secret, dataDir: opts.dataDir });
		endpoint = store.endpoint;
	} catch (e) {
		steps.push({ name: 'open destination', ok: false, skipped: false, durationMs: 0, detail: (e as Error).message, providerCode: e instanceof StoreFailure ? e.error.providerCode : null });
	}
	if (store) {
		const s = store;
		const key = `${s.prefix}${PROBE_PREFIX}${newId('probe', opts.now())}`;
		const body = `granary ops probe ${new Date(opts.now()).toISOString()}`;
		let failed = false;
		const step = async (name: string, fn: () => Promise<string | null>) => {
			if (failed) {
				steps.push({ name, ok: false, skipped: true, durationMs: 0, detail: 'skipped after an earlier failure', providerCode: null });
				return;
			}
			const t0 = performance.now();
			try {
				const detail = await fn();
				steps.push({ name, ok: true, skipped: false, durationMs: Math.round(performance.now() - t0), detail, providerCode: null });
			} catch (e) {
				failed = true;
				steps.push({ name, ok: false, skipped: false, durationMs: Math.round(performance.now() - t0), detail: (e as Error).message.slice(0, 300), providerCode: e instanceof StoreFailure ? e.error.providerCode : null });
			}
		};
		await step('PUT probe', async () => {
			await s.putText(key, body, 'text/plain');
			opts.onEgress?.(body.length);
			return key;
		});
		await step('HEAD probe', async () => {
			const h = await s.head(key);
			if (!h) throw new Error('probe not found after PUT');
			if (h.size !== body.length) throw new Error(`size ${h.size} ≠ ${body.length}`);
			return `${h.size} bytes`;
		});
		await step('LIST prefix', async () => {
			const l = await s.list(`${s.prefix}${PROBE_PREFIX}`);
			if (!l.some((o) => o.key === key)) throw new Error('probe missing from listing');
			return `${l.length} probe object(s) under ${s.prefix}${PROBE_PREFIX}`;
		});
		await step('GET probe', async () => {
			const t = await s.getText(key);
			if (t !== body) throw new Error('content differs');
			return 'content matches';
		});
		await step('PUT If-None-Match (expect 412)', async () => {
			const r = await s.putIfAbsent(key, 'overwrite attempt', 'text/plain');
			if (r !== 'exists') throw new Error('conditional PUT overwrote an existing object — commit markers would not be create-once');
			return '412 Precondition Failed (create-once works)';
		});
		const deleteFailedBefore = failed;
		failed = false; // always try to clean up
		await step('DELETE probe', async () => {
			await s.delete(key);
			return null;
		});
		await step('HEAD probe (expect 404)', async () => {
			if (await s.head(key)) throw new Error('probe still present after DELETE');
			return '404';
		});
		failed = failed || deleteFailedBefore;
	}
	const advisories = opts.settings.kind === 'r2' ? R2_ADVISORIES : opts.settings.kind === 's3' ? S3_ADVISORIES : [];
	return { ok: steps.length > 0 && steps.every((x) => x.ok), at: opts.now(), resolvedEndpoint: endpoint, steps, advisories };
}
