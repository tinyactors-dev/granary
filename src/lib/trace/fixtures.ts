/**
 * Realistic fake spans (ADR 0054): used by the StubBackend's trace buffer and,
 * as static fixtures, by the trace viewer's UI stories (/__dev/ui). Browser-safe.
 * Shapes mirror what the real app emits (ADR 0042): a webhook trace with
 * spawn + bootstrap + `issue.opened` → `allowlist.check` → `allowlist.verdict`
 * (cross-actor parent/child), a separate relay-reply trace, a `destroyed`
 * trace, a `scxml.finished` whose parent step is never emitted (an orphan),
 * and now and then a failed trace with an error span. A new flow appears
 * every few seconds so polling has something to show; ids are stable.
 * Call sites use tinyactors' own names (`scxml.macrostep …`); like the real
 * exporter, `span()` renames them `<family> <kind> …` and records
 * `tinyactors.span.{name,kind}` (ADR 0155).
 */
import type { SpanAttributeValue, SpanSummary } from '../schemas/dev';
import { applyFamilySpanName } from './span-name';

let counter = 0;
const id = (n: number) => {
	counter++;
	let out = '';
	let x = (counter * 2654435761 + n * 97) >>> 0;
	while (out.length < n) {
		x = (x * 1103515245 + 12345) >>> 0;
		out += (x >>> 8).toString(16).padStart(6, '0');
	}
	return out.slice(0, n);
};

type Attrs = Record<string, SpanAttributeValue>;

class Builder {
	readonly spans: SpanSummary[] = [];
	constructor(readonly traceId: string) {}
	span(name: string, start: number, dur: number, parent: string | null, attributes: Attrs, extra: Partial<SpanSummary> = {}): string {
		const spanId = id(16);
		const named = { name, attributes: { ...attributes } as Record<string, unknown> };
		applyFamilySpanName(named, typeof attributes['granary.actor.family'] === 'string' ? (attributes['granary.actor.family'] as string) : null);
		name = named.name;
		attributes = named.attributes as Attrs;
		this.spans.push({
			traceId: this.traceId,
			spanId,
			parentSpanId: parent,
			name,
			kind: 'internal',
			start,
			end: start + dur,
			durationMs: dur,
			attributes,
			status: { code: 'unset', message: null },
			events: [],
			service: 'granary',
			links: [],
			cause: null,
			...extra
		});
		return spanId;
	}
}

const actor = (address: string): Attrs => {
	const [family, name] = address.split('/') as [string, string];
	return { 'granary.actor.family': family, 'granary.actor.name': name, 'granary.actor.address': address };
};
const json = (v: unknown) => JSON.stringify(v);

/** One issue flow: 3–4 traces. `outcome` picks the ending. */
export function flow(at: number, repoId: number, n: number, login: string, outcome: 'closed' | 'allowed' | 'failed'): SpanSummary[] {
	const addr = `issue/${repoId}-${n}`;
	const A = actor(addr);
	const L = actor('allowlist/main');
	const t1 = new Builder(id(32));
	let t = at;
	t1.span('scxml.spawned', t, 0, null, { ...A, 'scxml.session_id': 8589934593 + n });
	const boot = t1.span('scxml.macrostep bootstrap', t + 0.02, 0.03, null, { ...A, 'scxml.state': json(['idle']) });
	t1.span('scxml.microstep (eventless)', t + 0.021, 0.012, boot, { ...A, 'scxml.state.entered': json(['restore']) }, {
		events: [{ name: 'scxml.condition', time: t + 0.025, attributes: { 'scxml.transition': 'restore → closing', 'scxml.result': false } }]
	});
	t1.span('scxml.microstep (eventless)', t + 0.034, 0.004, boot, { ...A, 'scxml.transition': json(['restore → idle']), 'scxml.state.exited': json(['restore']), 'scxml.state.entered': json(['idle']) });
	t += 1.1;
	const opened = t1.span('scxml.macrostep issue.opened', t, 0.05, null, {
		...A,
		'scxml.event.name': 'issue.opened',
		'scxml.event.type': 'external',
		'scxml.event.data': json({ issueKey: `${repoId}-${n}`, author: login, association: outcome === 'allowed' ? 'MEMBER' : 'NONE', title: 'Something is broken' }),
		'scxml.state': json(['checking'])
	});
	const toChecking = t1.span('scxml.microstep issue.opened', t + 0.006, 0.04, opened, {
		...A,
		'scxml.transition': json(['idle → checking on issue.opened']),
		'scxml.state.exited': json(['idle']),
		'scxml.state.entered': json(['checking'])
	});
	t += 0.6;
	const check = t1.span('scxml.macrostep allowlist.check', t, 0.06, toChecking, {
		...L,
		'scxml.event.name': 'allowlist.check',
		'scxml.event.data': json({ login, association: outcome === 'allowed' ? 'MEMBER' : 'NONE' }),
		'scxml.state': json(['ready'])
	}, { cause: { spanId: toChecking, traceId: t1.traceId } });
	const reply = t1.span('scxml.microstep allowlist.check', t + 0.003, 0.05, check, { ...L, 'scxml.transition': json(['ready on allowlist.check']), 'scxml.state.entered': json([]) });
	t += 0.45;
	const allowed = outcome === 'allowed';
	const verdict = t1.span('scxml.macrostep allowlist.verdict', t, 0.03, reply, {
		...A,
		'scxml.event.name': 'allowlist.verdict',
		'scxml.event.data': json({ login, allowed, reason: allowed ? 'association' : 'not-allowed' }),
		'scxml.state': json([allowed ? 'allowed' : 'closing'])
	}, { cause: { spanId: reply, traceId: t1.traceId } });
	t1.span('scxml.microstep allowlist.verdict', t + 0.003, 0.025, verdict, {
		...A,
		'scxml.transition': json([allowed ? 'checking → allowed on allowlist.verdict' : 'checking → closing on allowlist.verdict']),
		'scxml.state.exited': json(['checking']),
		'scxml.state.entered': json([allowed ? 'allowed' : 'closing'])
	});
	const out = [...t1.spans];
	let endT = t + 0.04;
	if (allowed) {
		t1.span('scxml.finished', endT, 0, id(16), { ...A, 'scxml.final_state': 'allowed', 'granary.done.verdict': 'allowed', 'granary.done.reason': 'association' });
		out.push(t1.spans.at(-1)!);
	} else {
		// The relay's reply starts its own trace (ADR 0042).
		const t2 = new Builder(id(32));
		endT = t + (outcome === 'failed' ? 3100 : 420);
		const ev = outcome === 'failed' ? 'github.gave-up' : 'github.closed';
		const m = t2.span(`scxml.macrostep ${ev}`, endT, 0.03, null, {
			...A,
			'scxml.event.name': ev,
			'scxml.event.data': json(outcome === 'failed' ? { effectKey: `close:${repoId}:${n}`, attempts: 6, lastError: 'HTTP 500' } : { effectKey: `close:${repoId}:${n}`, commentId: 1000 + n }),
			'scxml.state': json([])
		});
		t2.span(`scxml.microstep ${ev}`, endT + 0.004, 0.02, m, {
			...A,
			'scxml.transition': json([`closing → ${outcome} on ${ev}`]),
			'scxml.state.exited': json(['closing']),
			'scxml.state.entered': json([outcome])
		}, outcome === 'failed' ? { status: { code: 'error', message: 'github-gave-up: HTTP 500' } } : {});
		t2.span('scxml.finished', endT + 0.03, 0, id(16), {
			...A,
			'scxml.final_state': outcome,
			'granary.done.verdict': outcome,
			'granary.done.reason': outcome === 'failed' ? 'github-gave-up: HTTP 500' : 'not-allowed'
		}, outcome === 'failed' ? { status: { code: 'error', message: 'finished in failed' } } : {});
		out.push(...t2.spans);
	}
	const t3 = new Builder(id(32));
	t3.span('scxml.destroyed', endT + 0.4, 0, null, { ...A });
	out.push(...t3.spans);
	return out;
}

const LOGINS = ['mallory', 'eve', 'bob', 'trent', 'oscar', 'sybil'];

export class StubTraces {
	#spans: SpanSummary[] = [];
	#next = 1;
	#last = 0;

	constructor() {
		const now = Date.now();
		// allowlist boot trace
		const b = new Builder(id(32));
		const L = actor('allowlist/main');
		b.span('scxml.spawned', now - 60_000, 0, null, { ...L });
		const boot = b.span('scxml.macrostep bootstrap', now - 60_000 + 0.02, 0.02, null, { ...L, 'scxml.state': json(['ready']) });
		b.span('scxml.microstep (eventless)', now - 60_000 + 0.021, 0.01, boot, { ...L, 'scxml.state.entered': json(['ready']) });
		this.#spans.push(...b.spans);
		for (let i = 0; i < 5; i++) this.#add(now - 50_000 + i * 9_000);
		this.#last = now;
	}

	#add(at: number): void {
		const n = this.#next++;
		const outcome = n % 5 === 3 ? 'failed' : n % 3 === 2 ? 'allowed' : 'closed';
		this.#spans.push(...flow(at, 700001, n, LOGINS[n % LOGINS.length]!, outcome));
		if (this.#spans.length > 2000) this.#spans.splice(0, this.#spans.length - 2000);
	}

	/** All buffered spans, oldest first; a new flow every 8 s of wall time. */
	all(): SpanSummary[] {
		const now = Date.now();
		if (now - this.#last > 8000) {
			this.#add(now - 500);
			this.#last = now;
		}
		return this.#spans;
	}
}

// ---------------------------------------------------------------------------
// Static fixtures for UI stories (deterministic ids and times)
// ---------------------------------------------------------------------------

/** 2026-09-28T09:00:00Z */
const FIXTURE_T0 = Date.UTC(2026, 8, 28, 9, 0, 0);

function fixture(make: () => SpanSummary[]): SpanSummary[] {
	counter = 0;
	return make();
}

export const TRACE_FIXTURES = {
	/** One issue closed by granary: webhook trace, relay reply trace, destroyed. */
	singleIssue: () => fixture(() => flow(FIXTURE_T0, 700001, 42, 'mallory', 'closed')),
	/** The relay gave up: the reply trace carries error spans. */
	errorSpan: () => fixture(() => flow(FIXTURE_T0, 700001, 43, 'eve', 'failed')),
	/** An allowed issue: its `scxml.finished` span's parent step is never emitted. */
	missingParent: () => fixture(() => flow(FIXTURE_T0, 700001, 44, 'alice', 'allowed')),
	/** Forty issue flows over ~10 minutes, all outcomes. */
	manyTraces: () =>
		fixture(() => {
			const out: SpanSummary[] = [];
			for (let n = 1; n <= 40; n++) {
				const outcome = n % 5 === 3 ? 'failed' : n % 3 === 2 ? 'allowed' : 'closed';
				out.push(...flow(FIXTURE_T0 + n * 15_000, 700001, n, LOGINS[n % LOGINS.length]!, outcome));
			}
			return out;
		}),
	/** Nothing recorded yet. */
	empty: (): SpanSummary[] => []
} as const;
export type TraceFixture = keyof typeof TRACE_FIXTURES;
