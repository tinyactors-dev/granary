/**
 * Datasets for the JSON view stories (ADR 0077), lifted from the former
 * /admin/components/json-view playground (ADR 0057).
 */
export type Dataset = { id: string; label: string; make: () => unknown };

function issueEvent() {
	return {
		action: 'opened',
		issue: {
			id: 2847561023,
			number: 42,
			title: 'App crashes when the config file is empty',
			body: 'Steps to reproduce:\n1. Create an empty granary.toml\n2. Run `granary start`\n\nExpected: a helpful error.',
			state: 'open',
			state_reason: null,
			user: { login: 'mallory', id: 90210, type: 'User', site_admin: false },
			author_association: 'NONE',
			labels: [],
			html_url: 'https://github.com/acme/widgets/issues/42',
			reactions: { total_count: 0, '+1': 0, '-1': 0 }
		},
		repository: { id: 1790584260717, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' }, private: false },
		sender: { login: 'mallory', id: 90210, type: 'User' }
	};
}

function deep(levels = 14) {
	let v: Record<string, unknown> = { leaf: true, note: 'bottom of the well' };
	for (let i = levels; i > 0; i--) v = { [`level${i}`]: v, siblings: [i, i * 2], name: `node-${i}` };
	return v;
}

function large(rows: number) {
	const states = ['pending', 'inflight', 'done', 'dead'];
	return {
		generatedAt: '2026-09-28T09:00:00.000Z',
		effects: Array.from({ length: rows }, (_, i) => ({
			effect_key: `close:1790584260717:${i + 1}`,
			issue_key: `1790584260717-${i + 1}`,
			state: states[i % 4],
			attempts: i % 7,
			comment_id: i % 3 ? 1790584800000 + i : null,
			last_error: i % 4 === 3 ? `HTTP 503 from POST /repos/acme/widgets/issues/${i + 1}/comments` : null,
			payload: { owner: 'acme', repo: 'widgets', number: i + 1, author: `user${i % 50}` },
			updated_at: 1790584800000 + i * 1000
		}))
	};
}

function strings() {
	return {
		ascii: 'plain',
		unicode: 'Grüße, 你好, مرحبا, नमस्ते, こんにちは 👋🏽',
		emoji: '🧪🔥🦀🐙',
		rtl: 'שלום עולם',
		escapes: 'tab\there, newline\nthere, quote " and backslash \\',
		long: 'Lorem ipsum dolor sit amet, '.repeat(120),
		'key with spaces': 1,
		'dotted.key': 2,
		'slash/key~tilde': 3,
		'': 'empty key'
	};
}

function numbers() {
	return {
		bigintAsString: '18446744073709551615',
		sessionId: '4294967297',
		realBigint: 9007199254740993n,
		float: 3.14159,
		negative: -42,
		exponent: 6.02e23,
		nan: Number.NaN,
		infinity: Number.POSITIVE_INFINITY,
		bools: [true, false],
		nothing: null,
		missing: undefined
	};
}

function people() {
	const names = ['alice', 'bob', 'carol', 'dave', 'eve', 'mallory', 'trent'];
	return names.map((login, i) => ({
		login,
		id: 1000 + i,
		association: i < 2 ? 'MEMBER' : 'NONE',
		allowed: i < 3,
		issues: Array.from({ length: i % 3 }, (_, k) => ({ number: i * 10 + k, title: `Issue ${k} by ${login}` }))
	}));
}

function inspectorShapes() {
	return {
		logins: { $set: ['alice', 'zoe', 'admin'] },
		byRepo: { $map: { 'acme/widgets': 3, 'acme/gears': 1 } },
		startedAt: '2026-09-28T08:55:11.458Z',
		buffer: '[Uint8Array 12 bytes]',
		fn: '[Function checkAllowed]',
		self: '[Circular]',
		error: { name: 'TypeError', message: 'Cannot read properties of null' },
		big: '…',
		'…': '312 more keys'
	};
}

function jsValues() {
	const o: Record<string, unknown> = {
		set: new Set(['a', 'b', 'c']),
		map: new Map<unknown, unknown>([
			['alice', { allowed: true }],
			[42, 'numeric key']
		]),
		date: new Date('2026-09-28T09:00:00Z'),
		bigint: 12345678901234567890n,
		fn: function checkAllowed() {},
		typed: new Uint8Array(12)
	};
	o.self = o; // cycle
	return o;
}


export const JSON_DATASETS: Dataset[] = [
	{ id: 'small', label: 'Webhook payload (small)', make: issueEvent },
	{ id: 'deep', label: 'Deeply nested (14 levels)', make: () => deep(14) },
	{ id: 'large10k', label: 'Large: 1,100 effects (~12k nodes)', make: () => large(1100) },
	{ id: 'large50k', label: 'Huge: 5,000 effects (~55k nodes)', make: () => large(5000) },
	{ id: 'strings', label: 'Unicode & long strings, odd keys', make: strings },
	{ id: 'numbers', label: 'Numbers, bigint, null/undefined', make: numbers },
	{ id: 'people', label: 'Array of objects', make: people },
	{ id: 'inspector', label: 'Actor-inspector shapes ($set/$map…)', make: inspectorShapes },
	{ id: 'js', label: 'Live JS values (Map, Set, Date, cycle)', make: jsValues }
];

export const JSON_DATASET_IDS = JSON_DATASETS.map((d) => d.id);

export function jsonDataset(id: string): unknown {
	return (JSON_DATASETS.find((d) => d.id === id) ?? JSON_DATASETS[0]!).make();
}
