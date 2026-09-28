/**
 * Application logs (ADR 0234), observed at the harness's OTLP collector like
 * Loki would receive them: structured webhook / relay / backup records with
 * trace correlation, the HTTP access log, levels, and redaction.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { OPS_TEST, runCli, useHarness } from './harness';
import { actorFinished } from './traces';
import { openIssue } from './helpers';
import { consumeLoginLink } from './github-app';
import { OpsClient, OPS_SERVICE } from './ops';
import type { DecodedLog } from './otlp';

const h = useHarness({ infra: true });
const T = 90_000;
const HEX32 = /^[0-9a-f]{32}$/;

const logs = (): DecodedLog[] => h().collector.logs;
const bodyOf = (l: DecodedLog) => String(l.body ?? '');
const waitLog = (pred: (l: DecodedLog) => boolean, message: string) => h().waitFor(() => logs().find(pred), { timeout: 20_000, message });

beforeEach(async () => {
	await h().fakeGithub.reset({ keepApps: true });
});

describe('application logs', () => {
	test(
		'a webhook produces a structured outcome record correlated with the request span and the issue actor trace',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { message: `${i.address.name} closed` });

			const outcome = await waitLog((l) => l.service === 'granary' && l.attributes['github.delivery_id'] === i.deliveryId && l.attributes['webhook.outcome'] === 'accepted', 'webhook outcome record');
			expect(bodyOf(outcome)).toBe('webhook: issues.opened accepted');
			expect(outcome.severityText).toBe('INFO');
			expect(outcome.attributes['github.event']).toBe('issues');
			expect(outcome.attributes['github.issue.number']).toBe(i.number);
			expect(outcome.attributes['granary.issue_key']).toBe(i.issueKey);
			expect(outcome.traceId).toMatch(HEX32);

			// The access log line for the same request carries the same trace id.
			const access = await waitLog((l) => l.service === 'granary' && l.attributes['url.path'] === '/webhook' && l.traceId === outcome.traceId, 'webhook access log');
			expect(access.attributes['http.request.method']).toBe('POST');
			expect(access.attributes['http.response.status_code']).toBe(202);
			expect(typeof access.attributes['duration_ms']).toBe('number');

			// That trace holds the HTTP server span and the issue actor's macrosteps.
			const trace = await h().waitFor(() => {
				const spans = h().spans().filter((s) => s.traceID === outcome.traceId);
				return spans.some((s) => s.kind === 'server' && s.name === 'POST /webhook') && spans.some((s) => s.attributes['granary.actor.address'] === `issue/${i.issueKey}`) ? spans : null;
			}, { timeout: 20_000, message: 'request span + actor spans in one trace' });
			const server = trace.find((s) => s.kind === 'server')!;
			expect(server.spanID).toBe(String(outcome.spanId));

			// The relay's effect and the verdict are logged with their keys.
			await waitLog((l) => l.attributes['relay.effect_key'] === i.effectKey && bodyOf(l).includes('done'), 'relay done record');
			const verdict = await waitLog((l) => l.attributes['granary.issue_key'] === i.issueKey && l.attributes['granary.verdict'] === 'closed', 'verdict record');
			expect(verdict.attributes['granary.reason']).toBeTruthy();
		},
		T
	);

	test(
		'backups log run and upload outcomes under granary-ops',
		async () => {
			const ops = new OpsClient(h());
			const runs = await ops.backupNow();
			expect(runs.length).toBeGreaterThan(0);
			const runId = runs[0]!.id;
			const done = await waitLog((l) => l.service === OPS_SERVICE && l.attributes['backup.run_id'] === runId && l.attributes['backup.state'] === 'succeeded', `run ${runId} succeeded record`);
			expect(done.severityText).toBe('INFO');
			expect(typeof done.attributes['duration_ms']).toBe('number');
			await waitLog((l) => l.service === OPS_SERVICE && l.attributes['backup.run_id'] === runId && bodyOf(l).includes('started'), `run ${runId} started record`);
			await waitLog((l) => l.service === OPS_SERVICE && l.attributes['backup.run_id'] === runId && typeof l.attributes['backup.destination_id'] === 'string' && bodyOf(l).includes('done'), `upload done record for ${runId}`);
		},
		T
	);

	test(
		'health probes stay out of the exported log at the default level',
		async () => {
			for (let n = 0; n < 5; n++) await h().fetchApp('/healthz');
			await h().fetchApp('/readyz');
			// A request that is logged, flushed after the probes: once it arrives, the probes would have too.
			const marker = `/no-such-page-${Date.now()}`;
			await h().fetchApp(marker);
			const notFound = await waitLog((l) => l.attributes['url.path'] === marker, 'access log for the marker request');
			expect(notFound.attributes['http.response.status_code']).toBe(404);
			expect(notFound.severityText).toBe('INFO');
			expect(logs().filter((l) => l.attributes['url.path'] === '/healthz' || l.attributes['url.path'] === '/readyz')).toEqual([]);
		},
		T
	);

	test(
		'secrets, login-link tokens and sessions never reach the exported logs',
		async () => {
			const out = await runCli(h(), ['login-link', 'admin', '--json']);
			const url = String((JSON.parse(out.stdout) as { url: string }).url);
			const token = url.split('/auth/link/')[1]!;
			const { cookie } = await consumeLoginLink(h(), url);
			const session = cookie.split('=')[1]?.split(';')[0] ?? '';
			await h().fetchApp(`/auth/callback?code=secret-oauth-code-123&state=secret-state-456`);
			await waitLog((l) => l.attributes['auth.method'] === 'login-link' && l.attributes['auth.outcome'] === 'ok', 'login-link sign-in record');
			const signIn = await waitLog((l) => String(l.attributes['url.path'] ?? '').startsWith('/auth/link/'), 'login-link access log');
			expect(signIn.attributes['url.path']).toBe('/auth/link/[redacted]');
			await waitLog((l) => l.attributes['url.path'] === '/auth/callback', 'OAuth callback access log');

			const everything = JSON.stringify(logs(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
			for (const [what, secret] of [
				['login-link token', token],
				['session id', session],
				['OAuth code', 'secret-oauth-code-123'],
				['OAuth state', 'secret-state-456'],
				['master key', OPS_TEST.masterKey],
				['storage secret key', OPS_TEST.secretAccessKey]
			] as const) {
				expect(secret.length).toBeGreaterThan(6);
				expect(everything.includes(secret), `${what} leaked into exported logs`).toBe(false);
			}
		},
		T
	);
});
