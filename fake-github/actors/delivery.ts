/**
 * `delivery/<deliveryId>` — one webhook delivery (ADR 0060).
 *
 * Spawned by the host with the exact body to send (`params: {d}`). Starts in
 * `sending`, whose entry asks the `webhook` I/O processor to POST it; the
 * processor answers `webhook.result`, after which the actor rests in
 * `delivered` (2xx) or `failed` (anything else / unreachable) and answers
 * every waiter. A waiter is an `ask`: `delivery.wait` waits for the attempt
 * in progress (or is answered at once from a rest state); `redeliver` from a
 * rest state sends the SAME body with the SAME delivery id again (while
 * sending it just waits for the attempt in progress). The waiters'
 * `_event.origin`s are kept in `waiting` and answered with `<foreach>`.
 */
import { chart, reply, scxml } from '../../src/lib/charts';
import type { FakeDelivery } from '../schemas';
import { WEBHOOK_IO, WEBHOOK_POST, WEBHOOK_RESULT, type WebhookPost, type WebhookResult } from '../io/webhook';

export const DELIVERY_FAMILY = 'delivery';
export const deliveryAddress = (id: string) => `${DELIVERY_FAMILY}/${id}`;
export const DELIVERY_EVENTS = { wait: 'delivery.wait', redeliver: 'redeliver', result: WEBHOOK_RESULT } as const;

export interface DeliveryData {
	id: string;
	event: string;
	action: string;
	body: string;
	repoId: number | null;
	issueNumber: number | null;
	status: FakeDelivery['status'];
	responseCode: number | null;
	attempts: number;
	lastAttemptAt: number | null;
	lastError: string | null;
	/** Monotonic creation order (`ids.ts`); orders `state.deliveries` oldest first. */
	createdAt: number;
	/** The GitHub App's hook URL and secret (ADR 0200, 0230). */
	url: string;
	secret: string;
	appId: number;
	installationId: number | null;
}

/** `{deliveryId, responseCode}` — the answer every waiter gets. */
export interface DeliveryReply {
	deliveryId: string;
	responseCode: number | null;
}

// Chart helpers (embedded with Function.prototype.toString): self-contained.

function is2xx(code: number | null): boolean {
	return code !== null && code >= 200 && code < 300;
}

function startAttempt(d: DeliveryData): WebhookPost {
	d.status = 'pending';
	d.attempts += 1;
	return { deliveryId: d.id, event: d.event, body: d.body, url: d.url, secret: d.secret, appId: d.appId };
}

function record(d: DeliveryData, r: WebhookResult): void {
	d.responseCode = r.responseCode;
	d.lastError = r.error;
	d.lastAttemptAt = r.at;
	d.status = is2xx(r.responseCode) ? 'delivered' : 'failed';
}

function replyOf(d: DeliveryData): DeliveryReply {
	return { deliveryId: d.id, responseCode: d.responseCode };
}

/** Answer every waiter with the attempt's outcome, then forget them. */
const answerWaiting = scxml`<foreach array="waiting" item="origin"><send event="reply" targetexpr="origin"><content expr="replyOf(d)"/></send></foreach><assign location="waiting" expr="[]"/>`;
const addWaiter = scxml`<script>waiting.push(_event.origin)</script>`;

const rest = (id: string) =>
	scxml`<state id="${id}">
	<transition event="${DELIVERY_EVENTS.redeliver}" target="sending">${addWaiter}</transition>
	<transition event="${DELIVERY_EVENTS.wait}">${reply('replyOf(d)')}</transition>
</state>`;

const initial: DeliveryData = {
	id: '',
	event: 'issues',
	action: '',
	body: '',
	repoId: null,
	issueNumber: null,
	status: 'pending',
	responseCode: null,
	attempts: 0,
	lastAttemptAt: null,
	lastError: null,
	createdAt: 0,
	url: '',
	secret: '',
	appId: 0,
	installationId: null
};

export const deliveryChart = chart({
	name: DELIVERY_FAMILY,
	initial: 'sending',
	helpers: { is2xx, startAttempt, record, replyOf },
	// `waiting`: the `_event.origin` of each waiting ask.
	data: { d: initial, waiting: [] },
	body: scxml`<state id="sending">
	<onentry><send type="${WEBHOOK_IO}" event="${WEBHOOK_POST}"><content expr="startAttempt(d)"/></send></onentry>
	<transition event="${DELIVERY_EVENTS.redeliver} ${DELIVERY_EVENTS.wait}">${addWaiter}</transition>
	<transition event="${DELIVERY_EVENTS.result}" cond="is2xx(_event.data.responseCode)" target="delivered"><script>record(d, _event.data)</script>${answerWaiting}</transition>
	<transition event="${DELIVERY_EVENTS.result}" target="failed"><script>record(d, _event.data)</script>${answerWaiting}</transition>
	<transition event="error" target="failed"><script>record(d, { responseCode: null, error: _event.name, at: Date.now() })</script>${answerWaiting}</transition>
</state>
${rest('delivered')}
${rest('failed')}`
});
