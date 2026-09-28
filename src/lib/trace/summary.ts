/**
 * Group buffered spans into trace summaries for the /admin trace explorer
 * (ADR 0054). Pure; shared by the real Tracer and the StubBackend.
 */
import type { ListRecentTracesInput, SpanSummary, TraceSummary } from '../schemas/dev';

const ADDRESS = 'granary.actor.address';
const FAMILY = 'granary.actor.family';
const EVENT = 'scxml.event.name';

export type ResolvedTraceQuery = ListRecentTracesInput & { limit: number };

export function summarizeTraces(spans: readonly SpanSummary[], q: ResolvedTraceQuery): TraceSummary[] {
	const byTrace = new Map<string, SpanSummary[]>();
	for (const s of spans) {
		let list = byTrace.get(s.traceId);
		if (!list) byTrace.set(s.traceId, (list = []));
		list.push(s);
	}

	const family = q.family;
	const address = q.address?.toLowerCase();
	const search = q.search?.toLowerCase();

	const out: TraceSummary[] = [];
	for (const [traceId, list] of byTrace) {
		const t = summarizeTrace(traceId, list);
		if (family && !t.families.includes(family)) continue;
		if (address && !t.addresses.some((a) => a.toLowerCase().includes(address))) continue;
		if (search && !matchesSearch(list, search)) continue;
		out.push(t);
	}
	out.sort((a, b) => b.start - a.start || b.end - a.end);
	return out.slice(0, q.limit);
}

function matchesSearch(list: readonly SpanSummary[], needle: string): boolean {
	for (const s of list) {
		if (s.name.toLowerCase().includes(needle)) return true;
		const ev = s.attributes[EVENT];
		if (typeof ev === 'string' && ev.toLowerCase().includes(needle)) return true;
		for (const e of s.events) if (e.name.toLowerCase().includes(needle)) return true;
	}
	return false;
}

export function summarizeTrace(traceId: string, list: readonly SpanSummary[]): TraceSummary {
	const ids = new Set(list.map((s) => s.spanId));
	const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
	const tops = sorted.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
	const root = tops.find((s) => !s.parentSpanId) ?? tops[0] ?? null;
	const orphanCount = sorted.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId)).length;

	const services: string[] = [];
	const addresses: string[] = [];
	const families: string[] = [];
	const events: string[] = [];
	const linked: string[] = [];
	const add = (arr: string[], v: unknown) => {
		if (typeof v === 'string' && v && !arr.includes(v)) arr.push(v);
	};
	let errorCount = 0;
	let start = Infinity;
	let end = -Infinity;
	for (const s of sorted) {
		add(services, s.service);
		add(addresses, s.attributes[ADDRESS]);
		add(families, s.attributes[FAMILY]);
		add(events, s.attributes[EVENT]);
		for (const l of s.links) if (l.traceId !== traceId) add(linked, l.traceId);
		if (s.cause?.traceId && s.cause.traceId !== traceId) add(linked, s.cause.traceId);
		if (s.status.code === 'error') errorCount++;
		start = Math.min(start, s.start);
		end = Math.max(end, s.end);
	}
	const rootAddress = root?.attributes[ADDRESS];
	return {
		traceId,
		rootSpanId: root?.spanId ?? null,
		rootName: root?.name ?? '(no spans)',
		rootAddress: typeof rootAddress === 'string' ? rootAddress : null,
		services,
		addresses,
		families,
		events,
		spanCount: list.length,
		errorCount,
		orphanCount,
		start: Number.isFinite(start) ? start : 0,
		end: Number.isFinite(end) ? end : 0,
		durationMs: Number.isFinite(start) ? Math.max(0, end - start) : 0,
		linkedTraceIds: linked
	};
}
