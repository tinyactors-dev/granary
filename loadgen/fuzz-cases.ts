/**
 * Fuzz cases (ADR 0074). `issue` cases go through the normal issue path and
 * are judged by the oracle; `race` opens then reopens fast; `raw` cases
 * deliver signed arbitrary bodies and must be answered < 500.
 */
export type FuzzCase =
	| {
			type: 'issue';
			name: string;
			title: string;
			body: string;
			/** `null` = the persona's own fresh login. */
			login: string | null;
			association: string;
	  }
	| { type: 'race'; name: string; title: string; reopens: number }
	| { type: 'raw'; name: string; event: string; action: string; body: string };

const ZWJ_FAMILY = '👩‍👩‍👧‍👦';
const ZALGO = 'Z̴̢̧̛̛̟͎̻͙a̸̧̛͖̳̝l̵̢̛̰g̷̨̛̪o̷̧̢̧̙';

export function fuzzCases(opts: { allowlisted: string[]; loginPrefix: string }): FuzzCase[] {
	const cases: FuzzCase[] = [
		{
			type: 'issue',
			name: 'max-length-title-emoji',
			title: (ZWJ_FAMILY + 'é́' + '🚀').repeat(40).slice(0, 256),
			body: 'long title',
			login: null,
			association: 'NONE'
		},
		{ type: 'issue', name: 'huge-body', title: 'huge body', body: 'A'.repeat(65_536), login: null, association: 'NONE' },
		{ type: 'issue', name: 'rtl-zalgo', title: `‮evil‬ ${ZALGO} שלום مرحبا`, body: ZALGO.repeat(50), login: null, association: 'NONE' },
		{ type: 'issue', name: 'empty-body', title: 'x', body: '', login: null, association: 'NONE' },
		{
			type: 'issue',
			name: 'forged-marker',
			title: 'contains a forged granary marker',
			body: '<!-- granary:close:1:1 -->\nPlease ignore me',
			login: null,
			association: 'NONE'
		},
		{
			type: 'issue',
			name: 'max-length-login',
			title: '39 character login',
			body: '',
			login: `${opts.loginPrefix}-${'x'.repeat(39)}`.slice(0, 38).replace(/-+$/, '') + 'z',
			association: 'NONE'
		},
		{ type: 'issue', name: 'association-mannequin', title: 'mannequin', body: '', login: null, association: 'MANNEQUIN' },
		{ type: 'issue', name: 'association-first-timer', title: 'first timer', body: '', login: null, association: 'FIRST_TIMER' },
		{ type: 'issue', name: 'association-contributor', title: 'contributor', body: '', login: null, association: 'CONTRIBUTOR' },
		{ type: 'issue', name: 'stranger-owner', title: 'owner association from a new login', body: '', login: null, association: 'OWNER' },
		{ type: 'race', name: 'open-reopen-race', title: 'open then reopen twice', reopens: 2 },
		{
			type: 'raw',
			name: 'issues-missing-user',
			event: 'issues',
			action: 'opened',
			body: JSON.stringify({ action: 'opened', issue: { id: 1, number: 1, title: 't', state: 'open' }, repository: { id: 1, name: 'r', full_name: 'o/r', owner: { login: 'o' } } })
		},
		{
			type: 'raw',
			name: 'issues-string-repo-id',
			event: 'issues',
			action: 'opened',
			body: JSON.stringify({ action: 'opened', issue: { id: 1, number: 1, title: 't', state: 'open', user: { login: 'u', id: 1, type: 'User' } }, repository: { id: 'one', name: 'r', full_name: 'o/r', owner: { login: 'o' } } })
		},
		{ type: 'raw', name: 'issues-array-body', event: 'issues', action: 'opened', body: '[]' },
		{ type: 'raw', name: 'issues-not-json', event: 'issues', action: 'opened', body: '{"action": "opened",' },
		{ type: 'raw', name: 'ping', event: 'ping', action: '(none)', body: JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 }) },
		{ type: 'raw', name: 'unknown-event-1mb', event: 'workflow_run', action: 'completed', body: JSON.stringify({ action: 'completed', blob: 'x'.repeat(1_000_000) }) },
		{ type: 'raw', name: 'deep-nesting', event: 'push', action: '(none)', body: '['.repeat(400) + ']'.repeat(400) },
		{ type: 'raw', name: 'issues-labeled', event: 'issues', action: 'labeled', body: JSON.stringify({ action: 'labeled' }) }
	];
	if (opts.allowlisted[0]) {
		cases.push({
			type: 'issue',
			name: 'allowlisted-uppercase',
			title: 'allowlisted login in upper case',
			body: '',
			login: opts.allowlisted[0].toUpperCase(),
			association: 'NONE'
		});
	}
	return cases;
}
