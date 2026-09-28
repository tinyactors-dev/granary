/**
 * HTML for the fake GitHub: `GET /` (drive the control API by hand) and the
 * OAuth "sign in as" page. Plain HTML + a little JS; no build step.
 */
import type { FakeUser } from './schemas';

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --border:#3d444d; --accent:#4493f8; --ok:#3fb950; --bad:#f85149; } }
* { box-sizing: border-box; }
body { margin:0; padding:16px; font:14px/1.5 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0 0 8px; }
p.lead { color: var(--muted); margin: 0 0 16px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
section { border:1px solid var(--border); border-radius:8px; padding:12px; min-width:0; }
label { display:block; font-size:12px; color:var(--muted); margin-top:6px; }
input, select, textarea { width:100%; font:inherit; padding:4px 6px; border:1px solid var(--border); border-radius:6px; background:transparent; color:inherit; }
button { margin-top:8px; font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--border); background:transparent; color:var(--accent); cursor:pointer; }
button:hover { border-color: var(--accent); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:top; }
.wide { grid-column: 1 / -1; overflow-x:auto; }
.open { color: var(--ok); } .closed { color: var(--bad); }
code, pre { font: 12px ui-monospace, monospace; }
pre { white-space: pre-wrap; word-break: break-all; margin:0; }
#log { max-height: 160px; overflow:auto; }
a { color: var(--accent); }
`;

export function controlPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake GitHub</title><style>${STYLE}</style></head>
<body><main>
<h1>Fake GitHub</h1>
<p class="lead">Drive the <code>/__control</code> API (ADR 0006, ADR 0035). Webhooks go to the configured <code>FAKE_GITHUB_WEBHOOK_URL</code>.</p>
<div class="grid">
<section><h2>Open an issue</h2>
<form data-endpoint="/__control/issues">
<label>owner<input name="owner" value="acme" required></label>
<label>repo<input name="repo" value="widgets" required></label>
<label>author<input name="author" value="mallory" required></label>
<label>association<select name="association">
${['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'COLLABORATOR', 'MEMBER', 'OWNER'].map((a) => `<option>${a}</option>`).join('')}
</select></label>
<label>title<input name="title" value="Something is broken" required></label>
<label>body<textarea name="body" rows="2"></textarea></label>
<button>Create + deliver</button></form></section>
<section><h2>Reopen</h2>
<form data-endpoint="/__control/issues/reopen">
<label>owner<input name="owner" value="acme" required></label>
<label>repo<input name="repo" value="widgets" required></label>
<label>number<input name="number" type="number" min="1" value="1" required></label>
<label>actor<input name="actor" value="acme" required></label>
<button>Reopen + deliver</button></form></section>
<section><h2>Inject a REST fault</h2>
<form data-endpoint="/__control/faults">
<label>method<select name="method"><option>POST</option><option>PATCH</option><option>GET</option><option>PUT</option><option>DELETE</option><option>*</option></select></label>
<label>pathPattern (RegExp, unanchored)<input name="pathPattern" value="/comments$" required></label>
<label>status<input name="status" type="number" min="400" max="599" value="500" required></label>
<label>count<input name="count" type="number" min="1" value="2" required></label>
<label>retryAfter (s, optional)<input name="retryAfter" type="number" min="0"></label>
<button>Inject</button></form></section>
<section><h2>Users &amp; misc</h2>
<form data-endpoint="/__control/users">
<label>login<input name="login" value="alice" required></label>
<label>type<select name="type"><option>User</option><option>Bot</option><option>Organization</option></select></label>
<button>Ensure user</button></form>
<button id="reset">Reset everything</button>
<label>last response</label><pre id="log">–</pre></section>
<section class="wide"><h2>Issues</h2><table><thead><tr><th>repo</th><th>#</th><th>title</th><th>author</th><th>state</th><th>comments</th><th></th></tr></thead><tbody id="issues"></tbody></table></section>
<section class="wide"><h2>Deliveries</h2><table><thead><tr><th>id</th><th>action</th><th>issue</th><th>status</th><th>code</th><th>attempts</th><th></th></tr></thead><tbody id="deliveries"></tbody></table></section>
<section class="wide"><h2>Faults</h2><table><thead><tr><th>id</th><th>method</th><th>pathPattern</th><th>status</th><th>remaining</th><th>retryAfter</th></tr></thead><tbody id="faults"></tbody></table></section>
<section class="wide"><h2>Users</h2><div id="users"></div></section>
</div></main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
async function call(endpoint, body) {
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
  const text = await res.text();
  $('#log').textContent = res.status + ' ' + text;
  await refresh();
}
for (const form of document.querySelectorAll('form[data-endpoint]')) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(form)) {
      if (v === '') continue;
      const input = form.elements[k];
      body[k] = input && input.type === 'number' ? Number(v) : v;
    }
    call(form.dataset.endpoint, body);
  });
}
$('#reset').onclick = () => confirm('Wipe all fake GitHub state?') && call('/__control/reset');
window.reopen = (owner, repo, number) => call('/__control/issues/reopen', { owner, repo, number, actor: owner });
window.redeliver = (id) => call('/__control/deliveries/' + encodeURIComponent(id) + '/redeliver');
async function refresh() {
  const s = await (await fetch('/__control/state')).json();
  $('#issues').innerHTML = s.issues.map((i) => '<tr><td>' + esc(i.owner + '/' + i.repo) + '</td><td>' + i.number + '</td><td>' + esc(i.title) +
    '</td><td>' + esc(i.user.login) + ' <small>' + esc(i.author_association) + '</small></td><td class="' + i.state + '">' + i.state + (i.state_reason ? ' (' + esc(i.state_reason) + ')' : '') +
    '</td><td>' + i.comments.map((c) => '<pre>' + esc(c.user.login + ': ' + c.body) + '</pre>').join('') + '</td><td>' +
    (i.state === 'closed' ? '<button onclick="reopen(' + esc(JSON.stringify(i.owner)) + ',' + esc(JSON.stringify(i.repo)) + ',' + i.number + ')">reopen</button>' : '') + '</td></tr>').join('');
  $('#deliveries').innerHTML = s.deliveries.slice().reverse().map((d) => '<tr><td><code>' + esc(d.id) + '</code></td><td>' + esc(d.action) + '</td><td>' + esc(d.issueNumber ?? '') +
    '</td><td>' + esc(d.status) + '</td><td>' + esc(d.responseCode ?? '–') + '</td><td>' + esc(d.attempts ?? '') + '</td><td><button onclick="redeliver(' + esc(JSON.stringify(d.id)) + ')">redeliver</button></td></tr>').join('');
  $('#faults').innerHTML = s.faults.map((f) => '<tr><td>' + esc(f.id) + '</td><td>' + esc(f.method) + '</td><td><code>' + esc(f.pathPattern) + '</code></td><td>' + f.status + '</td><td>' + f.remaining + '</td><td>' + esc(f.retryAfter ?? '') + '</td></tr>').join('');
  $('#users').textContent = s.users.map((u) => u.login + ' (' + u.type + ')').join(', ') || '–';
}
refresh();
setInterval(refresh, 2000);
</script></body></html>`;
}

export function authorizePage(url: URL, users: FakeUser[]): string {
	const link = (login: string) => {
		const u = new URL(url);
		u.searchParams.set('login', login);
		return u.pathname + u.search;
	};
	const hidden = [...url.searchParams]
		.filter(([k]) => k !== 'login')
		.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
		.join('');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in (fake)</title><style>${STYLE} main { max-width: 420px; }</style></head>
<body><main>
<h1>Sign in to continue</h1>
<p class="lead">Fake GitHub OAuth: authorize <code>${esc(url.searchParams.get('client_id') ?? '')}</code> as</p>
<ul>${users.length ? users.map((u) => `<li><a href="${esc(link(u.login))}">${esc(u.login)}</a> <small>${esc(u.type)}</small></li>`).join('') : '<li>No users yet — type one below.</li>'}</ul>
<form method="get" action="/login/oauth/authorize">${hidden}
<label>any login<input name="login" required pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}"></label>
<button>Authorize</button></form>
</main></body></html>`;
}
