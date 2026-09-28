/**
 * OTLP/HTTP receiver (ADR 0135): `POST /otlp/v1/{traces,logs,metrics}`
 * directly, or `/v1/…` through an exe.dev proxy front (ADR 0137).
 * Protobuf and JSON. Direct requests need `Authorization: Bearer <token>` once
 * any `otlp-bearer` credential is active (otherwise open, like an Alloy
 * behind a private network).
 */
import type { System } from '@tinyactors/node';
import { ask } from '../io/reply';
import { COLLECTOR_ADDRESS, COLLECTOR_EVENTS, type OtlpBatch } from '../actors/collector';
import { CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS, type Credential } from '../actors/credentials';
import { FAULTS_ADDRESS, FAULT_EVENTS, type Fault } from '../actors/faults';
import { summarize, type Signal } from './decode';
import { droppedConnection } from '../s3/handler';
import type { InfraLog } from '../events';

export const OTLP_PREFIX = '/otlp';
const SIGNALS: Signal[] = ['traces', 'logs', 'metrics'];

export interface OtlpContext {
	system: System;
	log: InfraLog;
}

export type Via = OtlpBatch['via'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `/v1/traces` (after any prefix was stripped) → signal, else null. */
export function signalOf(path: string): Signal | null {
	const m = /^\/v1\/(traces|logs|metrics)\/?$/.exec(path);
	return m && SIGNALS.includes(m[1] as Signal) ? (m[1] as Signal) : null;
}

export async function handleOtlp(req: Request, path: string, via: Via, ctx: OtlpContext): Promise<Response> {
	const started = Date.now();
	const body = new Uint8Array(await req.arrayBuffer());
	let faultId: string | null = null;
	let credentialId: string | null = null;
	const finish = (res: Response) => {
		ctx.log.request({ at: started, surface: 'otlp', method: req.method, path, status: res.status, bytesIn: body.byteLength, credentialId, faultId });
		return res;
	};
	const signal = signalOf(path);
	if (!signal) return finish(Response.json({ error: `Unknown OTLP path ${path}` }, { status: 404 }));
	if (req.method !== 'POST') return finish(new Response('Method Not Allowed', { status: 405 }));

	const fault = await ask<Fault | null>(ctx.system, FAULTS_ADDRESS, FAULT_EVENTS.check, { target: 'otlp', method: 'POST', path });
	if (fault) {
		faultId = fault.id;
		ctx.log.emit({ type: 'fault.fired', faultId: fault.id, remaining: fault.remaining });
		if (fault.latencyMs) await sleep(fault.latencyMs);
		if (fault.dropConnection) return finish(droppedConnection());
		if (fault.status) {
			const headers: Record<string, string> = fault.retryAfterSec !== undefined ? { 'Retry-After': String(fault.retryAfterSec) } : {};
			return finish(Response.json({ code: fault.status, message: 'Injected fault' }, { status: fault.status, headers }));
		}
	}

	if (via === 'direct') {
		const guarded = await ask<boolean>(ctx.system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.anyActive, { kind: 'otlp-bearer' });
		if (guarded) {
			const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
			const cred = token ? await ask<Credential | null>(ctx.system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.byToken, { token, kind: 'otlp-bearer' }) : null;
			if (!cred || cred.revoked) return finish(Response.json({ code: 16, message: 'Unauthenticated' }, { status: 401 }));
			credentialId = cred.id;
		}
	}

	const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
	if (!contentType.includes('protobuf') && !contentType.includes('json'))
		return finish(Response.json({ code: 3, message: `Unsupported content type ${contentType}` }, { status: 415 }));
	let decoded;
	try {
		decoded = summarize(signal, contentType, body);
	} catch (e) {
		return finish(Response.json({ code: 3, message: `Undecodable ${signal} export: ${(e as Error).message}` }, { status: 400 }));
	}
	const batch: OtlpBatch = { at: started, signal, contentType, bytes: body.byteLength, service: decoded.service, via, summary: decoded.summary };
	await ask(ctx.system, COLLECTOR_ADDRESS, COLLECTOR_EVENTS.record, { batch });
	ctx.log.emit({ type: 'otlp.batch', batch });
	return finish(
		contentType.includes('json')
			? Response.json({})
			: new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } })
	);
}
