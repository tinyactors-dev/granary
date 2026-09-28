/** S3 XML responses (ADR 0131) — the documents Bun's S3 client parses. */
import type { ListResult } from '../actors/bucket';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

export const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const iso = (ms: number) => new Date(ms).toISOString();

export function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(`${XML_HEAD}\n${body}`, { status, headers: { 'Content-Type': 'application/xml', ...headers } });
}

export function errorXml(status: number, code: string, message: string, resource = '', headers: Record<string, string> = {}): Response {
	const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
	return xmlResponse(
		`<Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message><Resource>${esc(resource)}</Resource><RequestId>${requestId}</RequestId></Error>`,
		status,
		{ 'x-amz-request-id': requestId, ...headers }
	);
}

export function listV2Xml(
	bucket: string,
	r: ListResult,
	opts: { prefix: string; delimiter: string | null; maxKeys: number; continuationToken: string | null; startAfter: string | null; urlEncode: boolean }
): Response {
	const k = (s: string) => esc(opts.urlEncode ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
	const contents = r.contents
		.map(
			(o) =>
				`<Contents><Key>${k(o.key)}</Key><LastModified>${iso(o.lastModified)}</LastModified><ETag>&quot;${esc(o.etag)}&quot;</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
		)
		.join('');
	const prefixes = r.commonPrefixes.map((p) => `<CommonPrefixes><Prefix>${k(p)}</Prefix></CommonPrefixes>`).join('');
	const next = r.truncated && r.nextAfter ? `<NextContinuationToken>${esc(Buffer.from(r.nextAfter).toString('base64url'))}</NextContinuationToken>` : '';
	return xmlResponse(
		`<ListBucketResult xmlns="${NS}"><Name>${esc(bucket)}</Name><Prefix>${k(opts.prefix)}</Prefix>` +
			(opts.delimiter ? `<Delimiter>${k(opts.delimiter)}</Delimiter>` : '') +
			(opts.startAfter ? `<StartAfter>${k(opts.startAfter)}</StartAfter>` : '') +
			(opts.continuationToken ? `<ContinuationToken>${esc(opts.continuationToken)}</ContinuationToken>` : '') +
			`<KeyCount>${r.contents.length + r.commonPrefixes.length}</KeyCount><MaxKeys>${opts.maxKeys}</MaxKeys>` +
			(opts.urlEncode ? '<EncodingType>url</EncodingType>' : '') +
			`<IsTruncated>${r.truncated}</IsTruncated>${next}${contents}${prefixes}</ListBucketResult>`
	);
}

export const decodeContinuation = (token: string): string | null => {
	try {
		return Buffer.from(token, 'base64url').toString('utf8');
	} catch {
		return null;
	}
};

export const initiateXml = (bucket: string, key: string, uploadId: string) =>
	xmlResponse(
		`<InitiateMultipartUploadResult xmlns="${NS}"><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${esc(uploadId)}</UploadId></InitiateMultipartUploadResult>`
	);

export const completeXml = (location: string, bucket: string, key: string, etag: string) =>
	xmlResponse(
		`<CompleteMultipartUploadResult xmlns="${NS}"><Location>${esc(location)}</Location><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><ETag>&quot;${esc(etag)}&quot;</ETag></CompleteMultipartUploadResult>`
	);

export const listUploadsXml = (bucket: string, uploads: { uploadId: string; key: string; initiatedAt: number }[]) =>
	xmlResponse(
		`<ListMultipartUploadsResult xmlns="${NS}"><Bucket>${esc(bucket)}</Bucket><IsTruncated>false</IsTruncated>` +
			uploads
				.map((u) => `<Upload><Key>${esc(u.key)}</Key><UploadId>${esc(u.uploadId)}</UploadId><Initiated>${iso(u.initiatedAt)}</Initiated></Upload>`)
				.join('') +
			`</ListMultipartUploadsResult>`
	);

/** Parse `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"…"</ETag></Part>…`. */
export function parseCompleteBody(xml: string): { partNumber: number; etag: string }[] | null {
	const parts: { partNumber: number; etag: string }[] = [];
	const re = /<Part>([\s\S]*?)<\/Part>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const n = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(m[1]!);
		const e = /<ETag>\s*([\s\S]*?)\s*<\/ETag>/.exec(m[1]!);
		if (!n || !e) return null;
		parts.push({ partNumber: Number(n[1]), etag: e[1]!.replace(/&quot;/g, '"') });
	}
	return xml.includes('CompleteMultipartUpload') ? parts : null;
}
