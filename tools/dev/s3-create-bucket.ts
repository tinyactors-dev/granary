/**
 * Create an S3 bucket with a SigV4-signed `PUT /<bucket>` (idempotent).
 * Bun's S3 client cannot create buckets, so the local "real" stack
 * (`mise run up:real`, ADR 0027) uses this to prepare RustFS.
 *
 * Usage: bun tools/dev/s3-create-bucket.ts   (reads OPS_SEED_S3_* from env)
 */
import { createHash, createHmac } from 'node:crypto';

const endpoint = process.env.OPS_SEED_S3_ENDPOINT;
const bucket = process.env.OPS_SEED_S3_BUCKET;
const ak = process.env.OPS_SEED_S3_ACCESS_KEY_ID;
const sk = process.env.OPS_SEED_S3_SECRET_ACCESS_KEY;
const region = process.env.OPS_SEED_S3_REGION ?? 'us-east-1';
if (!endpoint || !bucket || !ak || !sk) {
	console.error('s3-create-bucket: OPS_SEED_S3_{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY} are required');
	process.exit(2);
}

const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}`);
const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
const date = amzDate.slice(0, 8);
const payloadHash = createHash('sha256').update('').digest('hex');
const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
const signed = Object.keys(headers).sort();
const canonical = ['PUT', url.pathname, '', ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payloadHash].join('\n');
const scope = `${date}/${region}/s3/aws4_request`;
const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
const kSigning = hmac(hmac(hmac(hmac('AWS4' + sk, date), region), 's3'), 'aws4_request');
const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');

for (let attempt = 1; ; attempt++) {
	try {
		const res = await fetch(url, {
			method: 'PUT',
			headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` }
		});
		const body = await res.text();
		if (res.ok || /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(body)) {
			console.log(`s3-create-bucket: ${bucket} ready at ${endpoint}`);
			process.exit(0);
		}
		console.error(`s3-create-bucket: ${res.status} ${body.slice(0, 300)}`);
		process.exit(1);
	} catch (e) {
		if (attempt >= 30) throw e;
		await Bun.sleep(1000); // store still starting
	}
}
