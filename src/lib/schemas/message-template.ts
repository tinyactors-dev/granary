/**
 * Closing-message templates (ADR 0250–0252).
 *
 * The comment granary posts when it closes an issue (or, once PR gating
 * lands, a pull request) is an in-product setting: one template per kind,
 * optionally overridden per repository. Templates are Markdown with a small,
 * logic-less variable syntax: `{{name}}` (whitespace inside the braces is
 * allowed). There are no conditionals, loops or filters.
 *
 * Values that come from the person who opened the issue (title, author) are
 * neutralised before they are inserted: Markdown and HTML metacharacters are
 * escaped (so a title cannot inject links, images, HTML or a fake
 * `<!-- granary:… -->` marker) and `@` is followed by a zero-width joiner so a
 * title cannot ping people. The hidden marker is appended by the relay, never
 * by the template, so a template cannot remove it.
 *
 * Pure: shared by the server (rendering at enqueue time), the CLI (`granary
 * config set messages.closing …` validation) and the browser editor.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Setting key in the platform `settings` kv (ADR 0157). */
export const CLOSING_MESSAGES_SETTING = 'messages.closing';

/** GitHub rejects comment bodies over 65536 characters; the relay adds the marker, so leave room. */
export const MAX_TEMPLATE_LENGTH = 60_000;
export const MAX_RENDERED_LENGTH = 65_000;

export type ClosingKind = 'issue' | 'pull_request';

/** The variables a template may use, with what they stand for (shown in the editor). */
export const TEMPLATE_VARIABLES = [
	{ name: 'author', description: 'Login of the person who opened it (no @)', userControlled: false },
	{ name: 'title', description: 'Title, with Markdown/HTML escaped and @-mentions neutralised', userControlled: true },
	{ name: 'number', description: 'Issue or pull request number', userControlled: false },
	{ name: 'kind', description: '"issue" or "pull request"', userControlled: false },
	{ name: 'owner', description: 'Repository owner (user or organisation)', userControlled: false },
	{ name: 'repo', description: 'Repository name', userControlled: false },
	{ name: 'repository', description: 'owner/repo', userControlled: false },
	{ name: 'url', description: 'Link to the issue or pull request', userControlled: false },
	{ name: 'association', description: "The author's association, e.g. NONE, CONTRIBUTOR", userControlled: false }
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]['name'];
const VARIABLE_NAMES = new Set<string>(TEMPLATE_VARIABLES.map((v) => v.name));

/** Built-in defaults (ADR 0004 wording). */
export const DEFAULT_TEMPLATES: Record<ClosingKind, string> = {
	issue:
		'Thanks for the report! Issues in this repository can only be opened by approved contributors, so this one was closed automatically.',
	pull_request:
		'Thanks for the pull request! Pull requests in this repository can only be opened by approved contributors, so this one was closed automatically.'
};

const Template = Type.String({ maxLength: MAX_TEMPLATE_LENGTH });
const NullableTemplate = Type.Union([Template, Type.Null()]);

/** Per-repository override; `null`/absent = use the global template for that kind. */
export const RepoTemplateOverride = Type.Object(
	{ issue: Type.Optional(NullableTemplate), pullRequest: Type.Optional(NullableTemplate) },
	{ additionalProperties: false }
);
export type RepoTemplateOverride = Static<typeof RepoTemplateOverride>;

/**
 * The stored setting. `null` = the built-in default. `repos` is keyed by
 * lower-cased `owner/repo`.
 */
export const ClosingMessages = Type.Object(
	{
		issue: NullableTemplate,
		pullRequest: NullableTemplate,
		repos: Type.Record(Type.String({ pattern: '^[a-z0-9_.-]+/[a-z0-9_.-]+$' }), RepoTemplateOverride)
	},
	{ additionalProperties: false }
);
export type ClosingMessages = Static<typeof ClosingMessages>;

export const EMPTY_CLOSING_MESSAGES: ClosingMessages = { issue: null, pullRequest: null, repos: {} };

/** What a template is rendered from (a subset of the outbox payload). */
export interface TemplateContext {
	kind: ClosingKind;
	author: string;
	title: string;
	number: number;
	owner: string;
	repo: string;
	url: string;
	association: string;
}

export interface TemplateProblem {
	message: string;
	/** Character offset into the template, when the problem has a place. */
	offset?: number;
}

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Validation: unknown variables, stray braces, length. Empty is allowed (the marker alone is posted). */
export function validateTemplate(template: string): TemplateProblem[] {
	const problems: TemplateProblem[] = [];
	if (template.length > MAX_TEMPLATE_LENGTH) problems.push({ message: `Template is too long (${template.length} of at most ${MAX_TEMPLATE_LENGTH} characters)` });
	for (const m of template.matchAll(TOKEN)) {
		const name = m[1]!;
		if (!VARIABLE_NAMES.has(name))
			problems.push({
				message: name === '' ? 'Empty variable {{ }}' : `Unknown variable {{${name}}} — use one of ${[...VARIABLE_NAMES].map((n) => `{{${n}}}`).join(', ')}`,
				offset: m.index
			});
	}
	// Braces left over after removing well-formed tokens are almost certainly typos ({{title} or {title}}).
	const rest = template.replace(TOKEN, '');
	const stray = /\{\{|\}\}/.exec(rest);
	if (stray) problems.push({ message: 'Unbalanced {{ or }} — variables look like {{title}}' });
	return problems;
}

/** Escape Markdown/HTML so a value renders as literal text on GitHub. */
export function escapeMarkdown(value: string): string {
	return value
		.replace(/\r?\n/g, ' ')
		.replace(/[\\`*_\[\]()#!|~]/g, (c) => `\\${c}`)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/^([-+])/, '\\$1')
		.replace(/^(\d+)\./, '$1\\.')
		.replace(/@/g, '@\u200d')
		// no autolinks from author-controlled text: break `scheme://` and `www.` with a zero-width space
		.replace(/:\/\//g, ':/\u200b/')
		.replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}\u200b.`);
}

/** GitHub logins / repo names in their own charset pass through untouched (so `@{{author}}` still mentions). */
const SAFE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const name = (v: string): string => (SAFE_NAME.test(v) ? v : escapeMarkdown(v));

function valueOf(name_: TemplateVariable, ctx: TemplateContext): string {
	switch (name_) {
		case 'author':
			return name(ctx.author);
		case 'title':
			return escapeMarkdown(ctx.title);
		case 'number':
			return String(ctx.number);
		case 'kind':
			return ctx.kind === 'pull_request' ? 'pull request' : 'issue';
		case 'owner':
			return name(ctx.owner);
		case 'repo':
			return name(ctx.repo);
		case 'repository':
			return `${name(ctx.owner)}/${name(ctx.repo)}`;
		case 'url':
			return /^https:\/\/[^\s<>()]+$/.test(ctx.url) ? ctx.url : escapeMarkdown(ctx.url);
		case 'association':
			return name(ctx.association);
	}
}

export class TemplateError extends Error {
	readonly problems: TemplateProblem[];
	constructor(problems: TemplateProblem[]) {
		super(problems.map((p) => p.message).join('; '));
		this.name = 'TemplateError';
		this.problems = problems;
	}
}

/** Render a template; throws `TemplateError` for an invalid template. The marker is NOT added here. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
	const problems = validateTemplate(template);
	if (problems.length) throw new TemplateError(problems);
	const out = template.replace(TOKEN, (_m, name: string) => valueOf(name as TemplateVariable, ctx));
	if (out.length > MAX_RENDERED_LENGTH) throw new TemplateError([{ message: `Rendered message is too long (${out.length} characters)` }]);
	return out;
}

/** The template in effect for a repository and kind: repo override → global → built-in default. */
export function resolveTemplate(messages: ClosingMessages, owner: string, repo: string, kind: ClosingKind): { template: string; source: 'repo' | 'global' | 'default' } {
	const field = kind === 'pull_request' ? 'pullRequest' : 'issue';
	const override = messages.repos[`${owner}/${repo}`.toLowerCase()]?.[field];
	if (typeof override === 'string') return { template: override, source: 'repo' };
	const global = messages[field];
	if (typeof global === 'string') return { template: global, source: 'global' };
	return { template: DEFAULT_TEMPLATES[kind], source: 'default' };
}

/** Every template in a setting, labelled, for whole-setting validation. */
export function templatesOf(messages: ClosingMessages): { where: string; template: string }[] {
	const out: { where: string; template: string }[] = [];
	if (messages.issue !== null) out.push({ where: 'issue', template: messages.issue });
	if (messages.pullRequest !== null) out.push({ where: 'pull request', template: messages.pullRequest });
	for (const [repo, o] of Object.entries(messages.repos)) {
		if (typeof o.issue === 'string') out.push({ where: `${repo} issue`, template: o.issue });
		if (typeof o.pullRequest === 'string') out.push({ where: `${repo} pull request`, template: o.pullRequest });
	}
	return out;
}

/** Validate a whole setting: problems are prefixed with where they are. */
export function validateClosingMessages(messages: ClosingMessages): string[] {
	return templatesOf(messages).flatMap(({ where, template }) => validateTemplate(template).map((p) => `${where}: ${p.message}`));
}

/** Sample data for previews and the component stories. */
export const TEMPLATE_SAMPLES: { id: string; label: string; ctx: TemplateContext }[] = [
	{ id: 'issue', label: 'Issue', ctx: { kind: 'issue', author: 'mallory', title: 'App crashes on startup', number: 42, owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets/issues/42', association: 'NONE' } },
	{ id: 'pr', label: 'Pull request', ctx: { kind: 'pull_request', author: 'drive-by', title: 'Fix typo in README', number: 7, owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets/pull/7', association: 'CONTRIBUTOR' } },
	{ id: 'long', label: 'Long title', ctx: { kind: 'issue', author: 'slop-fixer', title: 'Critical: '.concat('the application does not work as expected in several scenarios '.repeat(6)).trim(), number: 1337, owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets/issues/1337', association: 'FIRST_TIME_CONTRIBUTOR' } },
	{ id: 'unicode', label: 'Emoji / unicode', ctx: { kind: 'issue', author: 'jürgen', title: 'Größe 🐛 falsch — 中文 标题 ✨', number: 99, owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets/issues/99', association: 'NONE' } },
	{ id: 'mention', label: 'Mention attempt', ctx: { kind: 'issue', author: 'mallory', title: '@octocat @acme/everyone please look [click](https://evil.example) <!-- granary:close:1:1 -->', number: 13, owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets/issues/13', association: 'NONE' } }
];
