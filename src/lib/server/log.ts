/**
 * Structured logging for the server (ADR 0234).
 *
 * `log.info(message, ...rest)`: `rest` items that are plain objects become
 * attributes, an `Error` becomes `exception.*` attributes, anything else is
 * appended to the body. Each record is printed as one readable line (journald)
 * and handed to listeners (the OTLP exporter, `log-export.ts`).
 *
 * - Levels: debug < info < warn < error. `GRANARY_LOG_LEVEL` (default `info`)
 *   drops lower records entirely: not printed, not exported.
 * - Services: `log` is `granary`; `createLogger('granary-ops')` is the ops
 *   module's logger, so its records land under their own `service.name`.
 * - Context: `withLogContext({ traceId, spanId, attrs }, fn)` adds trace
 *   correlation and attributes to every record logged inside `fn`
 *   (AsyncLocalStorage), e.g. one HTTP request or one webhook.
 * - Keys that look like credentials are masked here, before printing or
 *   exporting; the ops fan-out additionally masks registered secret values.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
export type LogValue = string | number | boolean | null | undefined;
export type LogAttrs = Record<string, LogValue>;

export interface LogLine {
	at: number;
	level: LogLevel;
	service: string;
	message: string;
	/** Extra non-attribute arguments, formatted as strings. */
	details: string[];
	/** Flat attributes (undefined/null dropped, sensitive keys masked). */
	attrs: Record<string, string | number | boolean>;
	/** Trace correlation (lowercase hex), when logged inside a traced context. */
	traceId?: string;
	spanId?: string;
}

export interface LogContext {
	traceId?: string;
	spanId?: string;
	attrs?: LogAttrs;
}

type Listener = (line: LogLine) => void;

const g = globalThis as { [k: symbol]: unknown };
const LISTENERS = Symbol.for('granary.log.listeners');
const CONTEXT = Symbol.for('granary.log.context');
const LEVEL = Symbol.for('granary.log.level');
const listeners = (g[LISTENERS] ??= new Set<Listener>()) as Set<Listener>; // HMR-safe
const EARLY = Symbol.for('granary.log.early');
/** Records emitted before any listener attached (boot), replayed by the exporter; capped. */
const early = (g[EARLY] ??= [] as LogLine[]) as LogLine[];
const EARLY_MAX = 500;
const context = (g[CONTEXT] ??= new AsyncLocalStorage<LogContext>()) as AsyncLocalStorage<LogContext>;

const rank = (l: LogLevel) => LOG_LEVELS.indexOf(l);
const parseLevel = (v: string | undefined): LogLevel => {
	const l = (v ?? '').trim().toLowerCase();
	return (LOG_LEVELS as readonly string[]).includes(l) ? (l as LogLevel) : 'info';
};
if (g[LEVEL] === undefined) g[LEVEL] = parseLevel(process.env.GRANARY_LOG_LEVEL);

/** Current minimum level (records below it are dropped). */
export function logLevel(): LogLevel {
	return g[LEVEL] as LogLevel;
}
export function setLogLevel(level: LogLevel | string | undefined): void {
	g[LEVEL] = parseLevel(level);
}
export function levelEnabled(level: LogLevel): boolean {
	return rank(level) >= rank(logLevel());
}

/**
 * Receive every emitted log line: used to ship granary's logs to the ops
 * telemetry sinks (Loki via OTLP). Returns an unsubscribe function. A listener
 * that throws is ignored, never breaking the caller.
 */
export function onLog(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Take the records logged before the first listener attached (boot messages). */
export function drainEarlyLogs(): LogLine[] {
	return early.splice(0, early.length);
}

/** Run `fn` with trace correlation / attributes added to every record logged inside it. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
	const outer = context.getStore();
	const merged: LogContext = {
		traceId: ctx.traceId ?? outer?.traceId,
		spanId: ctx.spanId ?? outer?.spanId,
		attrs: { ...outer?.attrs, ...ctx.attrs }
	};
	return context.run(merged, fn);
}

/** Add attributes to the current context (e.g. the user once a request is authenticated). */
export function addLogContext(attrs: LogAttrs): void {
	const store = context.getStore();
	if (store) store.attrs = { ...store.attrs, ...attrs };
}

/** Attribute keys whose values are never printed or exported. */
export const SENSITIVE_LOG_KEY = /(^|[._-])(token|secret|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|pem|signature)($|[._-])/i;
const REDACTED = '[redacted]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

function flatten(into: Record<string, string | number | boolean>, src: Record<string, unknown> | undefined): void {
	if (!src) return;
	for (const [k, v] of Object.entries(src)) {
		if (v === undefined || v === null) continue;
		if (SENSITIVE_LOG_KEY.test(k)) {
			into[k] = REDACTED;
			continue;
		}
		if (typeof v === 'string' || typeof v === 'boolean') into[k] = v;
		else if (typeof v === 'number') into[k] = Number.isFinite(v) ? v : String(v);
		else if (typeof v === 'bigint') into[k] = v.toString();
		else if (v instanceof Date) into[k] = v.toISOString();
		else into[k] = JSON.stringify(v);
	}
}

function fmt(e: unknown): string {
	return typeof e === 'string' ? e : JSON.stringify(e);
}

function build(service: string, base: LogAttrs | undefined, level: LogLevel, message: string, rest: unknown[]): LogLine {
	const store = context.getStore();
	const attrs: Record<string, string | number | boolean> = {};
	flatten(attrs, store?.attrs);
	flatten(attrs, base);
	const details: string[] = [];
	for (const r of rest) {
		if (r instanceof Error) {
			flatten(attrs, { 'exception.type': r.name, 'exception.message': r.message, 'exception.stacktrace': r.stack });
			details.push(`${r.name}: ${r.message}`);
		} else if (isPlainObject(r)) flatten(attrs, r);
		else if (r !== undefined) details.push(fmt(r));
	}
	return { at: Date.now(), level, service, message, details, attrs, traceId: store?.traceId, spanId: store?.spanId };
}

const quote = (v: string | number | boolean) => {
	const s = String(v);
	return /[\s"=]/.test(s) || s === '' ? JSON.stringify(s) : s;
};

/** One readable line: `2026-…Z granary WARN message details key=value …` (stack traces on following lines). */
export function formatLine(l: LogLine): string {
	const lvl = l.level === 'info' ? '' : ` ${l.level.toUpperCase()}`;
	const extra = Object.entries(l.attrs)
		.filter(([k]) => k !== 'exception.stacktrace')
		.map(([k, v]) => `${k}=${quote(v)}`)
		.join(' ');
	const trace = l.traceId ? ` trace_id=${l.traceId}` : '';
	const head = `${new Date(l.at).toISOString()} ${l.service}${lvl} ${l.message}${l.details.length ? ' ' + l.details.join(' ') : ''}${extra ? ' ' + extra : ''}${trace}`;
	const stack = l.attrs['exception.stacktrace'];
	return typeof stack === 'string' ? `${head}\n${stack}` : head;
}

function emit(line: LogLine): void {
	const text = formatLine(line);
	if (line.level === 'error') console.error(text);
	else if (line.level === 'warn') console.warn(text);
	else console.log(text);
	if (listeners.size === 0) {
		if (early.length < EARLY_MAX) early.push(line);
		return;
	}
	for (const l of listeners) {
		try {
			l(line);
		} catch {
			/* a broken exporter must not break logging */
		}
	}
}

export interface Logger {
	readonly service: string;
	debug(message: string, ...rest: unknown[]): void;
	info(message: string, ...rest: unknown[]): void;
	warn(message: string, ...rest: unknown[]): void;
	error(message: string, ...rest: unknown[]): void;
	/** A logger that adds `attrs` to every record. */
	child(attrs: LogAttrs): Logger;
}

export function createLogger(service: string, base?: LogAttrs): Logger {
	const at = (level: LogLevel) => (message: string, ...rest: unknown[]) => {
		if (!levelEnabled(level)) return;
		emit(build(service, base, level, message, rest));
	};
	return {
		service,
		debug: at('debug'),
		info: at('info'),
		warn: at('warn'),
		error: at('error'),
		child: (attrs) => createLogger(service, { ...base, ...attrs })
	};
}

/** granary's logger (`service.name=granary`). */
export const log: Logger = createLogger('granary');

/** The current log context (trace ids, attributes), if any. */
export function currentLogContext(): LogContext | undefined {
	return context.getStore();
}

/** `traceparent` (sampled) for work started inside the given context, e.g. a webhook's actor. */
export function traceparentFor(ctx: LogContext | undefined): string | undefined {
	return ctx?.traceId && ctx.spanId ? `00-${ctx.traceId}-${ctx.spanId}-01` : undefined;
}
