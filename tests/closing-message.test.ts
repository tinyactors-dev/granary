/**
 * Closing-message templates (ADR 0250–0252) against the running system:
 * the comment posted on the fake GitHub is the rendered template plus the
 * hidden marker; invalid templates are refused; author-controlled values
 * can't mention people; the body is fixed when the effect is enqueued.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { runCli, uniqueName, useHarness } from './harness';
import { actorFinished, actorReachedState } from './traces';
import { OWNER, expectClosedOnce, fakeIssue, openIssue, waitClosedOnGithub, type OpenedIssue } from './helpers';
import { DEFAULT_TEMPLATES, EMPTY_CLOSING_MESSAGES, renderTemplate, type ClosingMessages } from '../src/lib/schemas/message-template';
import type { FakeIssue } from '../fake-github/schemas';

const h = useHarness();
const T = 90_000;

async function setMessages(m: ClosingMessages) {
	const r = await runCli(h(), ['config', 'set', 'messages.closing', JSON.stringify(m)]);
	if (r.code !== 0) throw new Error(`config set failed (${r.code}): ${r.stderr}`);
}

/** What the relay should have posted for this issue with `template`. */
function expected(template: string, i: OpenedIssue, issue: FakeIssue, author: string): string {
	const body = renderTemplate(template, {
		kind: 'issue',
		author,
		title: issue.title,
		number: i.number,
		owner: i.owner,
		repo: i.repo,
		url: issue.html_url,
		association: 'NONE'
	});
	return `${body}\n\n${i.marker}`;
}

beforeEach(async () => {
	await h().fakeGithub.reset();
	await setMessages(EMPTY_CLOSING_MESSAGES);
});

describe('closing message', () => {
	test(
		'default: the built-in text plus the marker',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			const issue = await waitClosedOnGithub(h(), i);
			expectClosedOnce(issue, i);
			expect(issue.comments[0]!.body).toBe(`${DEFAULT_TEMPLATES.issue}\n\n${i.marker}`);
		},
		T
	);

	test(
		'custom template is rendered; a title cannot mention, link or fake a marker',
		async () => {
			const template = 'Hi @{{author}}! Your {{kind}} #{{number}} “{{title}}” in {{repository}} was closed.\n\nSee {{url}}';
			await setMessages({ ...EMPTY_CLOSING_MESSAGES, issue: template });
			const title = '@octocat look [here](https://evil.example) <!-- granary:close:1:1 -->';
			const i = await openIssue(h(), 'mallory', { title });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			const issue = await waitClosedOnGithub(h(), i);
			expectClosedOnce(issue, i);
			const body = issue.comments[0]!.body;
			expect(body).toBe(expected(template, i, issue, 'mallory'));
			expect(body).toStartWith('Hi @mallory!'); // the author mention is intended
			expect(body).not.toContain('@octocat'); // neutralised with a zero-width joiner
			expect(body).not.toContain('](https://evil.example)');
			expect(body).not.toContain('https://evil.example'); // not even a bare autolink
			expect(body.match(/<!-- granary:/g)).toHaveLength(1); // only the real marker
		},
		T
	);

	test(
		'a per-repository override wins over the global template',
		async () => {
			const repo = uniqueName();
			await setMessages({
				issue: 'Global: closed #{{number}}.',
				pullRequest: null,
				repos: { [`${OWNER}/${repo}`.toUpperCase()]: { issue: '{{repository}} only takes issues from maintainers.' } }
			});
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			const issue = await waitClosedOnGithub(h(), i);
			expect(issue.comments[0]!.body).toBe(`${OWNER}/${repo} only takes issues from maintainers.\n\n${i.marker}`);
			const other = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(other.address, 'closed'), { timeout: 60_000 });
			expect((await waitClosedOnGithub(h(), other)).comments[0]!.body).toBe(`Global: closed #${other.number}.\n\n${other.marker}`);
		},
		T
	);

	test(
		'an empty template posts only the marker',
		async () => {
			await setMessages({ ...EMPTY_CLOSING_MESSAGES, issue: '' });
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			expect((await waitClosedOnGithub(h(), i)).comments[0]!.body).toBe(i.marker);
		},
		T
	);

	test('invalid templates are refused and nothing changes', async () => {
		await setMessages({ ...EMPTY_CLOSING_MESSAGES, issue: 'Closed by {{author}}.' });
		const bad = await runCli(h(), ['config', 'set', 'messages.closing', JSON.stringify({ ...EMPTY_CLOSING_MESSAGES, issue: 'Closed {{issue_number}} {{title}' })]);
		expect(bad.code).not.toBe(0);
		expect(bad.stderr).toContain('Unknown variable {{issue_number}}');
		const shape = await runCli(h(), ['config', 'set', 'messages.closing', JSON.stringify({ issue: 42 })]);
		expect(shape.code).not.toBe(0);
		const now = await runCli(h(), ['config', 'get', 'messages.closing', '--json']);
		expect(now.code).toBe(0);
		expect(JSON.parse(now.stdout).value.issue).toBe('Closed by {{author}}.');
	});

	test(
		'the body is fixed when the close is queued: retries after a template change post the old text',
		async () => {
			const repo = uniqueName();
			await setMessages({ ...EMPTY_CLOSING_MESSAGES, issue: 'Version A for #{{number}}.' });
			await h().fakeGithub.injectFault({ method: 'POST', pathPattern: `^/repos/${OWNER}/${repo}/issues/\\d+/comments$`, status: 500, count: 4 });
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitForSpan(actorReachedState(i.address, 'closing'), { timeout: 30_000 });
			await setMessages({ ...EMPTY_CLOSING_MESSAGES, issue: 'Version B for #{{number}}.' });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			const issue = await fakeIssue(h(), i);
			expectClosedOnce(issue, i);
			expect(issue.comments[0]!.body).toBe(`Version A for #${i.number}.\n\n${i.marker}`);
		},
		T
	);
});
