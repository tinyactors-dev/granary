/**
 * exe.dev proxy stand-in (ADR 0137) in front of the OTLP receiver:
 * - **token front** (stands in for `https://<vm>.exe.xyz:4318`): requires
 *   `X-Exedev-Authorization: Bearer <exe-vm-token>`; otherwise 401 with the
 *   login-redirect HTML exe.dev serves. The header is stripped and
 *   `X-ExeDev-UserID` added before the request reaches the receiver.
 * - **peer front** (stands in for `http://<n>.int.exe.xyz`, the VM-to-VM
 *   integration): no auth; `X-Exedev-Source-Vm` added.
 * Each front is its own listener; `PUT /__control/exe-proxy` turns them on/off.
 */
import type { Server } from 'bun';
import type { System } from '@tinyactors/node';
import { ask } from './io/reply';
import { CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS, type Credential } from './actors/credentials';
import { FAULTS_ADDRESS, FAULT_EVENTS, type Fault } from './actors/faults';
import { handleOtlp } from './otlp/handler';
import { droppedConnection } from './s3/handler';
import type { InfraLog } from './events';

export const EXE_AUTH_HEADER = 'x-exedev-authorization';

const LOGIN_HTML = (url: string) => `<!doctype html><html><head><title>Sign in · exe.dev</title></head><body>
<p>This VM is private. <a href="https://exe.dev/login?redirect=${encodeURIComponent(url)}">Sign in to exe.dev</a> to continue.</p>
</body></html>`;

interface Ctx {
	system: System;
	log: InfraLog;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function front(mode: 'token' | 'peer', req: Request, ctx: Ctx, peerSourceVm: () => string): Promise<Response> {
	const url = new URL(req.url);
	const started = Date.now();
	let credentialId: string | null = null;
	let faultId: string | null = null;
	const finish = (res: Response) => {
		ctx.log.request({ at: started, surface: 'exe-proxy', method: req.method, path: url.pathname, status: res.status, bytesIn: Number(req.headers.get('content-length') ?? 0), credentialId, faultId });
		return res;
	};
	const fault = await ask<Fault | null>(ctx.system, FAULTS_ADDRESS, FAULT_EVENTS.check, { target: 'exe-proxy', method: req.method, path: url.pathname });
	if (fault) {
		faultId = fault.id;
		ctx.log.emit({ type: 'fault.fired', faultId: fault.id, remaining: fault.remaining });
		if (fault.latencyMs) await sleep(fault.latencyMs);
		if (fault.dropConnection) return finish(droppedConnection());
		if (fault.status) {
			const headers: Record<string, string> = fault.retryAfterSec !== undefined ? { 'Retry-After': String(fault.retryAfterSec) } : {};
			return finish(new Response(`exe.dev proxy: injected ${fault.status}`, { status: fault.status, headers }));
		}
	}
	const headers = new Headers(req.headers);
	if (mode === 'token') {
		const token = /^Bearer\s+(.+)$/i.exec(req.headers.get(EXE_AUTH_HEADER) ?? '')?.[1]?.trim();
		const cred = token ? await ask<Credential | null>(ctx.system, CREDENTIALS_ADDRESS, CREDENTIAL_EVENTS.byToken, { token, kind: 'exe-vm-token' }) : null;
		if (!cred || cred.revoked) return finish(new Response(LOGIN_HTML(req.url), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		credentialId = cred.id;
		headers.delete(EXE_AUTH_HEADER);
		headers.set('X-ExeDev-UserID', `fake-user-${cred.id}`);
	} else {
		headers.set('X-Exedev-Source-Vm', peerSourceVm());
	}
	const forwarded = new Request(req.url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer() });
	const res = await handleOtlp(forwarded, url.pathname, mode === 'token' ? 'exe-token' : 'exe-peer', ctx);
	return finish(res);
}

export class ExeProxy {
	#token: Server<undefined> | null = null;
	#peer: Server<undefined> | null = null;
	#peerSourceVm = 'granary';

	constructor(
		private readonly ctx: Ctx,
		private readonly ports: { token: number; peer: number }
	) {}

	get state(): { tokenPort: number | null; peerPort: number | null } {
		return { tokenPort: this.#token?.port ?? null, peerPort: this.#peer?.port ?? null };
	}

	configure(o: { tokenMode: boolean; peerMode: boolean; peerSourceVm?: string }): void {
		if (o.peerSourceVm) this.#peerSourceVm = o.peerSourceVm;
		if (o.tokenMode && !this.#token) this.#token = this.#listen('token', this.ports.token);
		if (!o.tokenMode && this.#token) {
			this.#token.stop(true);
			this.#token = null;
		}
		if (o.peerMode && !this.#peer) this.#peer = this.#listen('peer', this.ports.peer);
		if (!o.peerMode && this.#peer) {
			this.#peer.stop(true);
			this.#peer = null;
		}
	}

	stop(): void {
		this.#token?.stop(true);
		this.#peer?.stop(true);
		this.#token = this.#peer = null;
	}

	#listen(mode: 'token' | 'peer', port: number): Server<undefined> {
		return Bun.serve({
			port,
			maxRequestBodySize: 256 * 1024 * 1024,
			fetch: (req) =>
				front(mode, req, this.ctx, () => this.#peerSourceVm).catch((e) => {
					console.error(`[fake-infra] exe-proxy ${mode}`, e);
					return new Response((e as Error).message, { status: 502 });
				})
		});
	}
}
