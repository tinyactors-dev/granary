/**
 * Observation, metrics and invariants for one scenario (ADR 0073).
 *
 * Fed with the fake GitHub's events for the scenario's repository; judges
 * granary against the policy oracle (ADR 0004), never against granary's own
 * bookkeeping. Not an actor: a plain in-memory ledger owned by the engine.
 */
import type { FakeEvent, FakeState } from '../fake-github/schemas';
import type {
	InvariantId,
	InvariantStatus,
	IssueRef,
	IssueTimelineEntry,
	Metrics,
	PersonaIssue,
	PersonaRef,
	SeriesPoint,
	Violation
} from './schemas';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MARKER = '<!-- granary:';
const MAX_SERIES = 900;
const MAX_VIOLATIONS = 1000;
const MAX_TIMELINE = 60;

export const INVARIANTS: Record<InvariantId, { title: string; description: string }> = {
	'allowed-stay-open': {
		title: 'Allowed issues stay open',
		description: 'granary never closes or comments on an issue by an allowlisted user or an OWNER/MEMBER/COLLABORATOR.'
	},
	'single-comment': {
		title: 'Exactly one granary comment',
		description: 'Every issue granary closed carries exactly one granary comment, and it contains the <!-- granary: marker.'
	},
	'close-once': {
		title: 'Closed at most once',
		description: 'granary closes an issue at most once; after a user reopens an issue granary closed, granary leaves it open.'
	},
	'eventually-closed': {
		title: 'Eventually closed',
		description: 'Every issue expected to be closed is closed by granary within the deadline (+ grace when faults were injected).'
	},
	'webhooks-healthy': {
		title: 'Webhooks healthy',
		description: 'No webhook delivery to granary gets a 5xx or fails to connect; malformed fuzz deliveries get < 500.'
	}
};

interface Ledger {
	number: number;
	title: string;
	author: string;
	association: string;
	expected: 'open' | 'closed' | null;
	openedAt: number;
	persona: PersonaRef | null;
	state: 'open' | 'closed';
	closedBy: string | null;
	granaryCloses: number;
	firstGranaryCloseAt: number | null;
	/** A user reopened after granary's last close. */
	reopenedAfterGranaryClose: boolean;
	reopens: number;
	granaryComments: { id: number; body: string }[];
	userComments: number;
	timeline: IssueTimelineEntry[];
	overdue: boolean;
	violated: Set<InvariantId>;
	/** Notifications that arrived before the persona was attached. */
	queued: Notification[];
}

export interface Notification {
	personaId: string;
	event: 'notify.closed' | 'notify.comment' | 'notify.reopened';
	data: Record<string, unknown>;
	/** For the persona's timeline. */
	text: string;
	number: number;
}

export interface ObserverOptions {
	owner: string;
	repo: string;
	fakeUrl: string;
	allowlisted: string[];
	granaryLogin: string;
	closeDeadlineMs: number;
	faultGraceMs: number;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function percentile(sorted: number[], p: number): number | null {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i]!;
}

export class Observer {
	repoId: number | null = null;
	readonly #o: ObserverOptions;
	readonly #allow: Set<string>;
	readonly #granary: string;
	#issues = new Map<number, Ledger>();
	#rawDeliveries = new Map<string, { caseName: string; persona: PersonaRef | null }>();
	#recentDeliveries: string[] = [];
	#violations: Violation[] = [];
	#violationCounts = new Map<InvariantId, number>();
	#latencies: number[] = [];
	#series: SeriesPoint[] = [];
	#startedAt: number | null = null;
	#finalized = false;
	faultsInjected = 0;
	redeliveries = 0;
	lastFaultAt: number | null = null;
	personaActions = 0;
	personaErrors = 0;
	deliveries = 0;
	deliveryFailures = 0;
	rawDeliveries = 0;
	reopenedByUsers = 0;
	userComments = 0;
	granaryComments = 0;
	closedByGranary = 0;

	constructor(o: ObserverOptions) {
		this.#o = o;
		this.#allow = new Set(o.allowlisted.map((l) => l.toLowerCase()));
		this.#granary = o.granaryLogin.toLowerCase();
	}

	start(now = Date.now()) {
		this.#startedAt ??= now;
	}

	#isGranary(login: string) {
		return login.toLowerCase() === this.#granary;
	}

	expectedFor(author: string, association: string): 'open' | 'closed' {
		return this.#allow.has(author.toLowerCase()) || TRUSTED_ASSOCIATIONS.has(association) ? 'open' : 'closed';
	}

	#ledger(number: number): Ledger {
		let l = this.#issues.get(number);
		if (!l) {
			l = {
				number,
				title: '',
				author: '',
				association: 'NONE',
				expected: null,
				openedAt: Date.now(),
				persona: null,
				state: 'open',
				closedBy: null,
				granaryCloses: 0,
				firstGranaryCloseAt: null,
				reopenedAfterGranaryClose: false,
				reopens: 0,
				granaryComments: [],
				userComments: 0,
				timeline: [],
				overdue: false,
				violated: new Set(),
				queued: []
			};
			this.#issues.set(number, l);
		}
		return l;
	}

	#line(l: Ledger, entry: IssueTimelineEntry) {
		l.timeline.push(entry);
		if (l.timeline.length > MAX_TIMELINE) l.timeline.splice(1, l.timeline.length - MAX_TIMELINE);
	}

	issueRef(l: Pick<Ledger, 'number' | 'title'>): IssueRef {
		return {
			number: l.number,
			repoId: this.repoId ?? 0,
			issueKey: `${this.repoId ?? 0}-${l.number}`,
			htmlUrl: `${this.#o.fakeUrl}/${this.#o.owner}/${this.#o.repo}/issues/${l.number}`,
			title: l.title
		};
	}

	#violate(invariant: InvariantId, message: string, l: Ledger | null, persona: PersonaRef | null = l?.persona ?? null) {
		if (l) {
			if (l.violated.has(invariant)) return;
			l.violated.add(invariant);
		}
		this.#violationCounts.set(invariant, (this.#violationCounts.get(invariant) ?? 0) + 1);
		this.#violations.push({
			id: `v${this.#violations.length + 1}`,
			invariant,
			at: Date.now(),
			message,
			persona,
			issue: l ? this.issueRef(l) : null,
			timeline: l ? [...l.timeline] : []
		});
		if (this.#violations.length > MAX_VIOLATIONS) this.#violations.shift();
	}

	#notify(l: Ledger, n: Omit<Notification, 'personaId' | 'number'>): Notification[] {
		if (!l.persona) {
			l.queued.push({ ...n, personaId: '', number: l.number });
			return [];
		}
		return [{ ...n, personaId: l.persona.id, number: l.number }];
	}

	/** Attach the persona that opened `number`; returns notifications queued before. */
	attachPersona(number: number, persona: PersonaRef, title: string): Notification[] {
		const l = this.#ledger(number);
		l.persona = persona;
		if (!l.title) l.title = title;
		const queued = l.queued.map((n) => ({ ...n, personaId: persona.id }));
		l.queued = [];
		return queued;
	}

	registerRaw(deliveryId: string, caseName: string, persona: PersonaRef | null) {
		this.#rawDeliveries.set(deliveryId, { caseName, persona });
	}

	/** A delivery of this scenario's repository to redeliver (chaos), chosen by `pick` ∈ [0,1). */
	pickDelivery(pick: number): string | null {
		if (!this.#recentDeliveries.length) return null;
		return this.#recentDeliveries[Math.floor(pick * this.#recentDeliveries.length)] ?? null;
	}

	markFault(now = Date.now()) {
		this.faultsInjected += 1;
		this.lastFaultAt = now;
	}

	#deadline(): number {
		return this.#o.closeDeadlineMs + (this.faultsInjected > 0 ? this.#o.faultGraceMs : 0);
	}

	/** Feed one fake-GitHub event; returns notifications for personas. */
	onEvent(e: FakeEvent): Notification[] {
		if (e.type === 'delivery') {
			const raw = this.#rawDeliveries.get(e.deliveryId);
			if (!raw && (this.repoId === null || e.repoId !== this.repoId)) return [];
			this.deliveries += 1;
			const code = e.responseCode;
			if (raw) {
				this.rawDeliveries += 1;
				if (code === null || code >= 500) {
					this.deliveryFailures += 1;
					this.#violate(
						'webhooks-healthy',
						`Fuzz case "${raw.caseName}" (${e.event}) was answered ${code ?? 'with no connection'} — must be < 500.`,
						null,
						raw.persona
					);
				}
				return [];
			}
			if (e.event === 'issues' || e.event === 'issue_comment') {
				this.#recentDeliveries.push(e.deliveryId);
				if (this.#recentDeliveries.length > 50) this.#recentDeliveries.shift();
			}
			const l = e.number !== null ? this.#issues.get(e.number) ?? null : null;
			if (l) this.#line(l, { at: e.at, type: 'delivery', by: null, detail: `${e.event}.${e.action} → ${code ?? 'unreachable'} (attempt ${e.attempt})` });
			if (code === null || code >= 500) {
				this.deliveryFailures += 1;
				this.#violate('webhooks-healthy', `Webhook ${e.event}.${e.action} (${e.deliveryId}) answered ${code ?? 'with no connection'}.`, null, l?.persona ?? null);
			}
			return [];
		}
		if (this.repoId === null || e.repoId !== this.repoId) return [];
		const l = this.#ledger(e.number);
		switch (e.type) {
			case 'issue.opened': {
				l.title = e.title;
				l.author = e.author;
				l.association = e.association;
				l.expected = this.expectedFor(e.author, e.association);
				l.openedAt = e.at;
				this.#line(l, { at: e.at, type: 'opened', by: e.author, detail: `opened by ${e.author} (${e.association}) — granary should leave it ${l.expected === 'open' ? 'open' : 'closed'}` });
				return [];
			}
			case 'issue.closed': {
				l.state = 'closed';
				l.closedBy = e.by;
				const byGranary = this.#isGranary(e.by);
				const latency = e.at - l.openedAt;
				this.#line(l, { at: e.at, type: 'closed', by: e.by, detail: `closed by ${e.by} as ${e.stateReason ?? '?'}${byGranary ? ` ${fmtMs(latency)} after opening` : ''}` });
				if (byGranary) {
					this.closedByGranary += 1;
					if (l.granaryCloses === 0) {
						l.firstGranaryCloseAt = e.at;
						this.#latencies.push(latency);
					}
					if (l.expected === 'open') {
						this.#violate('allowed-stay-open', `granary closed #${l.number} by ${l.author} (${l.association}), who is allowed.`, l);
					}
					if (l.granaryCloses > 0 && l.reopenedAfterGranaryClose) {
						this.#violate('close-once', `granary closed #${l.number} again after ${l.author} reopened it.`, l);
					} else if (l.granaryCloses > 0) {
						this.#violate('close-once', `granary closed #${l.number} a second time.`, l);
					}
					l.granaryCloses += 1;
					l.reopenedAfterGranaryClose = false;
				}
				return this.#notify(l, {
					event: 'notify.closed',
					data: { number: l.number, by: e.by, byGranary, stateReason: e.stateReason },
					text: `${e.by} closed #${l.number} as ${e.stateReason ?? '?'}${byGranary ? ` (${fmtMs(latency)} after opening)` : ''}`
				});
			}
			case 'issue.reopened': {
				l.state = 'open';
				l.reopens += 1;
				if (!this.#isGranary(e.by)) {
					this.reopenedByUsers += 1;
					if (l.granaryCloses > 0) l.reopenedAfterGranaryClose = true;
				}
				this.#line(l, { at: e.at, type: 'reopened', by: e.by, detail: `reopened by ${e.by}` });
				if (l.persona && e.by.toLowerCase() === l.persona.login.toLowerCase()) return [];
				return this.#notify(l, {
					event: 'notify.reopened',
					data: { number: l.number, by: e.by },
					text: `${e.by} reopened #${l.number}`
				});
			}
			case 'comment.created': {
				const byGranary = this.#isGranary(e.author);
				this.#line(l, { at: e.at, type: 'comment', by: e.author, detail: e.body.replace(/\s+/g, ' ').slice(0, 160) });
				if (byGranary) {
					this.granaryComments += 1;
					l.granaryComments.push({ id: e.commentId, body: e.body });
					if (l.expected === 'open') {
						this.#violate('allowed-stay-open', `granary commented on #${l.number} by ${l.author} (${l.association}), who is allowed.`, l);
					}
					if (l.granaryComments.length > 1) {
						this.#violate('single-comment', `granary left ${l.granaryComments.length} comments on #${l.number}.`, l);
					}
					if (!e.body.includes(MARKER)) {
						this.#violate('single-comment', `granary's comment on #${l.number} has no ${MARKER} marker.`, l);
					}
				} else {
					this.userComments += 1;
				}
				if (l.persona && e.author.toLowerCase() === l.persona.login.toLowerCase()) return [];
				return this.#notify(l, {
					event: 'notify.comment',
					data: { number: l.number, by: e.author, byGranary, body: e.body.slice(0, 2000) },
					text: `${e.author} commented on #${l.number}: “${e.body.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)}”`
				});
			}
		}
	}

	/** Expected-closed issues still open within their deadline. */
	pending(): number {
		let n = 0;
		for (const l of this.#issues.values()) if (l.expected === 'closed' && l.granaryCloses === 0 && !l.overdue) n++;
		return n;
	}

	/** Periodic checks + one series sample. */
	tick(now: number, activePersonas: number) {
		const deadline = this.#deadline();
		for (const l of this.#issues.values()) {
			if (l.expected === 'closed' && l.granaryCloses === 0 && !l.overdue && now - l.openedAt > deadline) {
				l.overdue = true;
				this.#violate(
					'eventually-closed',
					`#${l.number} by ${l.author} (${l.association}) was not closed within ${fmtMs(deadline)}.`,
					l
				);
			}
		}
		if (this.#startedAt === null) return;
		const sorted = [...this.#latencies].sort((a, b) => a - b);
		this.#series.push({
			t: Math.round((now - this.#startedAt) / 100) / 10,
			opened: this.#issues.size,
			closed: this.closedByGranary,
			backlog: this.pending(),
			p95: percentile(sorted, 95),
			deliveries: this.deliveries,
			errors: this.deliveryFailures + this.personaErrors,
			activePersonas
		});
		if (this.#series.length > MAX_SERIES) this.#series.splice(0, this.#series.length - MAX_SERIES);
	}

	/** Final reconciliation against the fake's state (authoritative comments). */
	reconcile(state: FakeState | null) {
		if (state && this.repoId !== null) {
			for (const issue of state.issues) {
				if (issue.repoId !== this.repoId) continue;
				const l = this.#issues.get(issue.number);
				if (!l) continue;
				const mine = issue.comments.filter((c) => this.#isGranary(c.user.login));
				if (l.granaryCloses > 0) {
					if (mine.length !== 1) this.#violate('single-comment', `#${l.number} was closed by granary with ${mine.length} granary comments (want 1).`, l);
					else if (!mine[0]!.body.includes(MARKER)) this.#violate('single-comment', `granary's comment on #${l.number} has no marker.`, l);
				}
				if (l.expected === 'open' && mine.length > 0) {
					this.#violate('allowed-stay-open', `#${l.number} by allowed ${l.author} has ${mine.length} granary comment(s).`, l);
				}
			}
		}
		for (const l of this.#issues.values()) {
			if (l.expected === 'closed' && l.granaryCloses === 0 && !l.overdue) {
				l.overdue = true;
				this.#violate('eventually-closed', `#${l.number} by ${l.author} was still open when the scenario ended.`, l);
			}
		}
		this.#finalized = true;
	}

	invariants(): InvariantStatus[] {
		const counts = { allowed: 0, closedByGranary: 0, expectedClosed: 0 };
		for (const l of this.#issues.values()) {
			if (l.expected === 'open') counts.allowed++;
			if (l.expected === 'closed') counts.expectedClosed++;
			if (l.granaryCloses > 0) counts.closedByGranary++;
		}
		const checked: Record<InvariantId, number> = {
			'allowed-stay-open': counts.allowed,
			'single-comment': counts.closedByGranary,
			'close-once': counts.closedByGranary,
			'eventually-closed': counts.expectedClosed,
			'webhooks-healthy': this.deliveries
		};
		return (Object.keys(INVARIANTS) as InvariantId[]).map((id) => {
			const violations = this.#violationCounts.get(id) ?? 0;
			let status: InvariantStatus['status'] = violations > 0 ? 'violated' : 'ok';
			if (!violations && !this.#finalized && (id === 'eventually-closed' ? this.pending() > 0 : checked[id] === 0)) status = 'pending';
			return { id, ...INVARIANTS[id], status, violations, checked: checked[id] };
		});
	}

	violations(): Violation[] {
		return [...this.#violations].reverse();
	}

	violationCount(): number {
		return [...this.#violationCounts.values()].reduce((a, b) => a + b, 0);
	}

	violationsFor(personaId: string): number {
		return this.#violations.filter((v) => v.persona?.id === personaId).length;
	}

	series(): SeriesPoint[] {
		return [...this.#series];
	}

	metrics(activeMs: number): Metrics {
		let expectedOpen = 0,
			expectedClosed = 0,
			allowedOpen = 0,
			overdue = 0;
		for (const l of this.#issues.values()) {
			if (l.expected === 'open') {
				expectedOpen++;
				if (l.state === 'open') allowedOpen++;
			}
			if (l.expected === 'closed') expectedClosed++;
			if (l.overdue) overdue++;
		}
		const sorted = [...this.#latencies].sort((a, b) => a - b);
		const minutes = activeMs / 60_000;
		return {
			issuesOpened: this.#issues.size,
			expectedOpen,
			expectedClosed,
			closedByGranary: this.closedByGranary,
			allowedOpen,
			pendingClose: this.pending(),
			overdue,
			reopenedByUsers: this.reopenedByUsers,
			userComments: this.userComments,
			granaryComments: this.granaryComments,
			deliveries: this.deliveries,
			deliveryFailures: this.deliveryFailures,
			rawDeliveries: this.rawDeliveries,
			faultsInjected: this.faultsInjected,
			redeliveries: this.redeliveries,
			personaActions: this.personaActions,
			personaErrors: this.personaErrors,
			latency: {
				count: sorted.length,
				p50: percentile(sorted, 50),
				p95: percentile(sorted, 95),
				p99: percentile(sorted, 99),
				max: sorted.length ? sorted[sorted.length - 1]! : null
			},
			throughputPerMin: minutes > 0 ? Math.round((this.#issues.size / minutes) * 10) / 10 : 0
		};
	}

	issuesOpened(): number {
		return this.#issues.size;
	}

	/** The issues a persona opened, with outcomes. */
	issuesOf(personaId: string): PersonaIssue[] {
		const out: PersonaIssue[] = [];
		for (const l of this.#issues.values()) {
			if (l.persona?.id !== personaId) continue;
			const expected = l.expected ?? 'closed';
			const outcome: PersonaIssue['outcome'] = l.violated.size
				? 'violation'
				: expected === 'closed' && l.granaryCloses === 0
					? 'pending'
					: 'as-expected';
			out.push({
				...this.issueRef(l),
				expected,
				state: l.state,
				closedBy: l.closedBy,
				latencyMs: l.firstGranaryCloseAt !== null ? l.firstGranaryCloseAt - l.openedAt : null,
				granaryComments: l.granaryComments.length,
				reopened: l.reopens,
				outcome,
				timeline: [...l.timeline]
			});
		}
		return out.sort((a, b) => a.number - b.number);
	}

	/** Per persona: [opened, closed by granary]. */
	issueCounts(personaId: string): [number, number] {
		let opened = 0,
			closed = 0;
		for (const l of this.#issues.values()) {
			if (l.persona?.id !== personaId) continue;
			opened++;
			if (l.granaryCloses > 0) closed++;
		}
		return [opened, closed];
	}
}
