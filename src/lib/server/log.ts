/** Minimal structured-ish logging for the server side. */
const stamp = () => new Date().toISOString();

function fmt(e: unknown): string {
	if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
	return typeof e === 'string' ? e : JSON.stringify(e);
}

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogLine {
	at: number;
	level: LogLevel;
	message: string;
	/** Extra arguments, already formatted as strings. */
	details: string[];
}
type Listener = (line: LogLine) => void;

const g = globalThis as { [k: symbol]: Set<Listener> | undefined };
const LISTENERS = Symbol.for('granary.log.listeners');
const listeners: Set<Listener> = (g[LISTENERS] ??= new Set()); // HMR-safe

/**
 * Receive every log line (ADR 0027): used to ship granary's logs to the ops
 * telemetry sinks (Loki via OTLP). Returns an unsubscribe function. A listener
 * that throws is ignored, never breaking the caller.
 */
export function onLog(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(level: LogLevel, message: string, details: string[]): void {
	if (listeners.size === 0) return;
	const line: LogLine = { at: Date.now(), level, message, details };
	for (const l of listeners) {
		try {
			l(line);
		} catch {
			/* a broken exporter must not break logging */
		}
	}
}

export const log = {
	info(message: string, ...rest: unknown[]): void {
		const d = rest.map(fmt);
		console.log(`${stamp()} granary ${message}`, ...d);
		emit('info', message, d);
	},
	warn(message: string, ...rest: unknown[]): void {
		const d = rest.map(fmt);
		console.warn(`${stamp()} granary WARN ${message}`, ...d);
		emit('warn', message, d);
	},
	error(message: string, ...rest: unknown[]): void {
		const d = rest.map(fmt);
		console.error(`${stamp()} granary ERROR ${message}`, ...d);
		emit('error', message, d);
	}
};
