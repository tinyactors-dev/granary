/**
 * The DAP TCP server (ADR 0009), dev mode only: `127.0.0.1:$DAP_PORT`, one
 * `createDebugSession(system, {allow: ['send','set','goto','evaluate']})`
 * per connection, framed with `DAPReader` / `encodeDAPMessage`. Clients
 * attach with `{"address": "family/name"}`. Every audit entry is logged.
 *
 * A singleton on `globalThis`, so Vite HMR never binds the port twice.
 */
import {
	createDebugSession,
	DAPReader,
	encodeDAPMessage,
	type DAPMessage,
	type DebugSession,
	type System
} from '@tinyactors/node';
import type { Socket, TCPSocketListener } from 'bun';
import { log } from './log';

interface Conn {
	session: DebugSession;
	reader: DAPReader;
	/** Bytes not yet accepted by the socket. */
	pending: Uint8Array[];
	closed: boolean;
}

const KEY = Symbol.for('granary.dap');
type Registry = { [KEY]?: { listener: TCPSocketListener<Conn>; system: System } };

export const DAP_HOST = '127.0.0.1';

function flush(socket: Socket<Conn>): void {
	const c = socket.data;
	while (c.pending.length) {
		const chunk = c.pending[0]!;
		const n = socket.write(chunk);
		if (n < 0) return;
		if (n < chunk.length) {
			c.pending[0] = chunk.subarray(n);
			return;
		}
		c.pending.shift();
	}
}

/** Starts (once) the DAP server for `system`. Returns the bound port, or null on failure. */
export function startDapServer(system: System, port: number): number | null {
	const g = globalThis as Registry;
	const existing = g[KEY];
	if (existing) {
		if (existing.system === system) return existing.listener.port;
		existing.listener.stop(true);
		delete g[KEY];
	}
	try {
		const listener = Bun.listen<Conn>({
			hostname: DAP_HOST,
			port,
			socket: {
				open(socket) {
					const data: Partial<Conn> = { pending: [], closed: false };
					socket.data = data as Conn;
					const send = (message: DAPMessage) => {
						if (data.closed) return;
						data.pending!.push(encodeDAPMessage(message));
						flush(socket);
					};
					data.session = createDebugSession(system, {
						allow: ['send', 'set', 'goto', 'evaluate'],
						audit: (entry) => log.info(`dap audit: ${JSON.stringify(entry)}`),
						send
					});
					data.reader = new DAPReader((message) => {
						data.session!.receive(message).catch((e) => log.error('dap: request failed', e));
					});
					log.info(`dap: client connected (session ${data.session.id})`);
				},
				data(socket, chunk) {
					try {
						socket.data.reader.push(chunk);
					} catch (e) {
						log.warn('dap: malformed stream, closing connection', e);
						socket.end();
					}
				},
				drain(socket) {
					flush(socket);
				},
				close(socket) {
					const c = socket.data;
					if (!c || c.closed) return;
					c.closed = true;
					c.session?.close();
					log.info(`dap: client disconnected (session ${c.session?.id})`);
				},
				error(socket, e) {
					log.warn('dap: socket error', e);
				}
			}
		});
		g[KEY] = { listener, system };
		log.info(`dap: listening on ${DAP_HOST}:${listener.port}`);
		return listener.port;
	} catch (e) {
		log.error(`dap: could not listen on ${DAP_HOST}:${port}`, e);
		return null;
	}
}

export function stopDapServer(): void {
	const g = globalThis as Registry;
	const existing = g[KEY];
	if (!existing) return;
	existing.listener.stop(true);
	delete g[KEY];
	log.info('dap: stopped');
}
