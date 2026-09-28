/** HTML for the fake GitHub App flows (ADR 0164, ADR 0200): manifest confirm and install. */
import { STYLE, esc } from './page';

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} (fake GitHub)</title><style>${STYLE} main { max-width: 560px; } textarea { width: 100%; min-height: 5rem; }</style></head>
<body><main>${body}</main></body></html>`;

/** "Create GitHub App" confirmation (github.com shows the manifest's name and permissions). */
export function manifestConfirmPage(args: {
	manifestJson: string;
	name: string;
	owner: string;
	ownerType: 'User' | 'Organization';
	state: string;
	permissions: Record<string, string>;
	events: string[];
}): string {
	const perms = Object.entries(args.permissions)
		.map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}</li>`)
		.join('');
	return page(
		'Create GitHub App',
		`<h1>Create GitHub App</h1>
<p class="lead">Create <strong>${esc(args.name)}</strong> for ${args.ownerType === 'Organization' ? 'organization' : 'user'} <strong>${esc(args.owner)}</strong>.</p>
<h2>Permissions</h2><ul>${perms || '<li>none</li>'}</ul>
<h2>Events</h2><p>${args.events.map((e) => `<code>${esc(e)}</code>`).join(' ') || 'none'}</p>
<form method="post" action="/settings/apps/new/confirm">
<input type="hidden" name="manifest" value="${esc(args.manifestJson)}">
<input type="hidden" name="state" value="${esc(args.state)}">
<input type="hidden" name="owner_type" value="${esc(args.ownerType)}">
<label>owner login <input name="owner" value="${esc(args.owner)}" required pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}"></label>
<button>Create GitHub App for ${esc(args.owner)}</button>
</form>`
	);
}

/** "Install <app>" page: pick the account and the repositories. */
export function installPage(args: { slug: string; name: string; account: string; state: string | null; knownRepos: string[] }): string {
	return page(
		`Install ${args.name}`,
		`<h1>Install ${esc(args.name)}</h1>
<form method="post" action="/apps/${esc(args.slug)}/installations/new/confirm">
${args.state ? `<input type="hidden" name="state" value="${esc(args.state)}">` : ''}
<label>account <input name="account" value="${esc(args.account)}" required pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}"></label>
<p><label><input type="radio" name="selection" value="all" checked> All repositories</label>
<label><input type="radio" name="selection" value="selected"> Only select repositories</label></p>
<label>repositories (<code>owner/name</code>, one per line; for "only select")<textarea name="repos">${esc(args.knownRepos.join('\n'))}</textarea></label>
<button>Install</button>
</form>`
	);
}
