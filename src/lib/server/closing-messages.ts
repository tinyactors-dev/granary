/**
 * Closing-message templates, server side (ADR 0250–0252): read, validate and
 * save the `messages.closing` setting in the platform `settings` kv, and
 * render the comment for an outbox payload. No SvelteKit imports: the CLI's
 * offline `granary config set messages.closing …` uses this too.
 */
import type { Database } from 'bun:sqlite';
import { check, issuesOf } from '../schemas/standard';
import {
	CLOSING_MESSAGES_SETTING,
	ClosingMessages,
	EMPTY_CLOSING_MESSAGES,
	renderTemplate,
	resolveTemplate,
	validateClosingMessages,
	DEFAULT_TEMPLATES,
	type ClosingKind,
	type TemplateContext
} from '../schemas/message-template';
import type { GitHubCloseData } from '../schemas/actors';
import { AdminStore, AdminStoreError, type SettingSource } from './admins';
import { log } from './log';

/** The stored setting, or the empty one (all defaults). A corrupt value falls back to defaults, loudly. */
export function readClosingMessages(db: Database): ClosingMessages {
	const s = new AdminStore(db).getSetting(CLOSING_MESSAGES_SETTING);
	if (!s) return EMPTY_CLOSING_MESSAGES;
	if (check(ClosingMessages, s.value) && validateClosingMessages(s.value).length === 0) return s.value;
	log.warn(`closing messages: stored ${CLOSING_MESSAGES_SETTING} is invalid; using the built-in defaults`);
	return EMPTY_CLOSING_MESSAGES;
}

/** Normalise repo keys to lower case and validate shape + every template; throws AdminStoreError('invalid'). */
export function normaliseClosingMessages(value: unknown): ClosingMessages {
	if (typeof value === 'object' && value !== null && 'repos' in value && typeof (value as { repos: unknown }).repos === 'object' && (value as { repos: unknown }).repos !== null) {
		const repos = (value as { repos: Record<string, unknown> }).repos;
		value = { ...(value as object), repos: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k.toLowerCase(), v])) };
	}
	if (!check(ClosingMessages, value)) {
		const why = issuesOf(ClosingMessages, value)
			.slice(0, 3)
			.map((i) => `${i.path.join('.') || '(value)'}: ${i.message}`)
			.join('; ');
		throw new AdminStoreError('invalid', `${CLOSING_MESSAGES_SETTING} must be {issue, pullRequest, repos} with templates or null (${why})`);
	}
	const problems = validateClosingMessages(value);
	if (problems.length) throw new AdminStoreError('invalid', problems.join('; '));
	return value;
}

export function saveClosingMessages(db: Database, value: unknown, source: SettingSource, by: string): ClosingMessages {
	const messages = normaliseClosingMessages(value);
	new AdminStore(db).setSetting(CLOSING_MESSAGES_SETTING, messages, source, by, {
		action: 'closing-message.set',
		details: {
			issue: messages.issue === null ? 'default' : 'custom',
			pullRequest: messages.pullRequest === null ? 'default' : 'custom',
			repos: Object.keys(messages.repos)
		}
	});
	return messages;
}

function contextOf(p: GitHubCloseData & { kind?: unknown }): TemplateContext {
	const kind: ClosingKind = p.kind === 'pull_request' ? 'pull_request' : 'issue';
	return { kind, author: p.author, title: p.title, number: p.number, owner: p.owner, repo: p.repo, url: p.htmlUrl, association: p.association };
}

/** The comment body (without the marker) for a close effect, from the templates in effect now. */
export function renderClosingBody(db: Database, payload: GitHubCloseData): string {
	const ctx = contextOf(payload);
	const { template, source } = resolveTemplate(readClosingMessages(db), payload.owner, payload.repo, ctx.kind);
	try {
		return renderTemplate(template, ctx);
	} catch (e) {
		log.warn(`closing messages: ${source} template for ${payload.owner}/${payload.repo} failed to render (${(e as Error).message}); using the default`);
		return renderTemplate(DEFAULT_TEMPLATES[ctx.kind], ctx);
	}
}

/** Body + the hidden marker, as posted. An empty body posts just the marker. */
export function commentWithMarker(body: string, marker: string): string {
	return body.trim() === '' ? marker : `${body}\n\n${marker}`;
}
