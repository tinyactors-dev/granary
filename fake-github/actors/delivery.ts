/**
 * `delivery/<deliveryId>` — one webhook delivery (ADR 0060).
 *
 * Spawned by the host with the exact body to send. Bootstraps into
 * `sending`, whose entry asks the `webhook` I/O processor to POST it; the
 * processor answers `webhook.result`, after which the actor rests in
 * `delivered` (2xx) or `failed` (anything else / unreachable) and replies to
 * every waiter (`reqIds`). `redeliver` from either rest state sends the
 * SAME body with the SAME delivery id again. A `redeliver` that arrives
 * while sending just waits for the attempt in progress.
 */
import { statechart, type TransitionBuilder } from '@tinyactors/node';
import type { FakeDelivery } from '../schemas';
import { REPLY_EVENT, REPLY_IO } from '../io/reply';
import { WEBHOOK_IO, WEBHOOK_RESULT, type WebhookPost, type WebhookResult } from '../io/webhook';

export const DELIVERY_FAMILY = 'delivery';
export const deliveryAddress = (id: string) => ({ family: DELIVERY_FAMILY, name: id });
export const DELIVERY_EVENTS = { redeliver: 'redeliver', result: WEBHOOK_RESULT } as const;

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
	/** ADR 0200: target of a GitHub App delivery (null = the default repo webhook). */
	url: string | null;
	secret: string | null;
	appId: number | null;
	installationId: number | null;
	/** Waiters to answer when the current attempt finishes. */
	reqIds: string[];
	out: unknown;
}

/** `{deliveryId, responseCode}` — the reply every waiter gets. */
export interface DeliveryReply {
	deliveryId: string;
	responseCode: number | null;
}

const is2xx = (code: number | null) => code !== null && code >= 200 && code < 300;

function record(d: DeliveryData, r: WebhookResult) {
	d.responseCode = r.responseCode;
	d.lastError = r.error;
	d.lastAttemptAt = r.at;
	d.status = is2xx(r.responseCode) ? 'delivered' : 'failed';
	d.out = { reqIds: d.reqIds, result: { deliveryId: d.id, responseCode: r.responseCode } satisfies DeliveryReply };
	d.reqIds = [];
}

const addWaiter = function (this: DeliveryData, ctx: { event?: { data: unknown } }) {
	const reqId = (ctx.event?.data as { reqId?: string } | undefined)?.reqId;
	if (reqId) this.reqIds.push(reqId);
};

function settle(t: TransitionBuilder<DeliveryData>) {
	t.script(function (this: DeliveryData, ctx) {
		record(this, ctx.event!.data as WebhookResult);
	}).send(REPLY_EVENT, (b) =>
		b.via(REPLY_IO).data(function (this: DeliveryData) {
			return this.out;
		})
	);
}

export const deliveryChart = statechart<DeliveryData>({ family: DELIVERY_FAMILY, revision: 'v1' })
	.data('id', '')
	.data('event', 'issues')
	.data('action', '')
	.data('body', '')
	.data('repoId', null)
	.data('issueNumber', null)
	.data('status', 'pending')
	.data('responseCode', null)
	.data('attempts', 0)
	.data('lastAttemptAt', null)
	.data('lastError', null)
	.data('createdAt', 0)
	.data('url', null)
	.data('secret', null)
	.data('appId', null)
	.data('installationId', null)
	.dataExpression('reqIds', () => [])
	.data('out', null)
	.state('sending', (s) =>
		s
			.entry((a) =>
				a
					.script(function (this: DeliveryData) {
						this.status = 'pending';
						this.attempts += 1;
					})
					.send('webhook.post', (b) =>
						b.via(WEBHOOK_IO).data(function (this: DeliveryData): WebhookPost {
							return { deliveryId: this.id, event: this.event, body: this.body, url: this.url, secret: this.secret, appId: this.appId };
						})
					)
			)
			.on(DELIVERY_EVENTS.redeliver, (t) => t.script(addWaiter))
			.on(DELIVERY_EVENTS.result, (t) =>
				settle(t.when((ctx) => is2xx((ctx.event!.data as WebhookResult).responseCode)).target('delivered'))
			)
			.on(DELIVERY_EVENTS.result, (t) => settle(t.target('failed')))
	)
	.state('delivered', (s) => s.on(DELIVERY_EVENTS.redeliver, (t) => t.target('sending').script(addWaiter)))
	.state('failed', (s) => s.on(DELIVERY_EVENTS.redeliver, (t) => t.target('sending').script(addWaiter)));
