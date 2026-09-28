/**
 * The `granary` CLI (ADR 0156, 0157, 0159): data-dir layout, exit codes and
 * the command catalogue. The catalogue is data so `granary help`, the manual
 * (`mise run docs:cli`) and tests share one source.
 */

/** Files and directories inside the data dir (ADR 0157). */
export const DATA_DIR_LAYOUT = {
	database: 'granary.sqlite',
	opsDatabase: 'ops.sqlite',
	masterKey: 'master.key',
	envFile: 'granary.env',
	adminSocket: 'admin.sock',
	pidFile: 'granary.pid'
} as const;

/** Default data dir of the systemd unit (ADR 0163). */
export const SYSTEM_DATA_DIR = '/var/lib/granary';

/** Minimum Bun version (`engines.bun`, checked by `serve` and `doctor`). */
export const MIN_BUN_VERSION = '1.4.1';

export const EXIT = {
	ok: 0,
	error: 1,
	usage: 2,
	/** The command needs a running server (admin socket) and there is none. */
	serverNotRunning: 3,
	/**
	 * The data dir is missing, not initialised, or not accessible as this user
	 * (ADR 0232). Nothing was created or written.
	 */
	dataDir: 4
} as const;

/**
 * - `socket`: only through the running server's admin socket.
 * - `socket-or-direct`: socket, else direct SQLite when no server runs.
 * - `offline`: refuses while a server runs (init, restore).
 * - `none`: talks to neither.
 */
export type CliTransport = 'socket' | 'socket-or-direct' | 'offline' | 'none';

export interface CliOption {
	name: string;
	/** `string` options take a value; `boolean` are flags. */
	type: 'string' | 'boolean';
	description: string;
	default?: string;
}

export interface CliCommand {
	/** Space-separated path, e.g. `admin add`. */
	name: string;
	args: string[];
	options: CliOption[];
	transport: CliTransport;
	description: string;
}

const DATA: CliOption = { name: 'data', type: 'string', description: 'Data directory (else GRANARY_DATA_DIR, /var/lib/granary if it exists, $XDG_STATE_HOME/granary, ~/.local/state/granary)' };
const JSON_OUT: CliOption = { name: 'json', type: 'boolean', description: 'Print the raw JSON result' };

export const CLI_COMMANDS: readonly CliCommand[] = [
	{ name: 'serve', args: [], transport: 'none', description: 'Run the granary server', options: [DATA, { name: 'host', type: 'string', description: 'Bind address', default: '0.0.0.0' }, { name: 'port', type: 'string', description: 'Port', default: '3000' }] },
	{ name: 'init', args: [], transport: 'offline', description: 'Create the data dir, generate and confirm the master key, write granary.env', options: [DATA, { name: 'origin', type: 'string', description: 'Public URL, e.g. https://granary.example.com' }, { name: 'yes-i-stored-the-key', type: 'boolean', description: 'Skip the interactive key confirmation' }, JSON_OUT] },
	{ name: 'doctor', args: [], transport: 'socket-or-direct', description: 'Check Bun, data dir, master key, databases, disk, ORIGIN and GitHub', options: [DATA, JSON_OUT] },
	{ name: 'admin add', args: ['login'], transport: 'socket-or-direct', description: 'Make a GitHub login an admin', options: [DATA, JSON_OUT] },
	{ name: 'admin remove', args: ['login'], transport: 'socket-or-direct', description: 'Remove an admin (not the last one)', options: [DATA, JSON_OUT] },
	{ name: 'admin list', args: [], transport: 'socket-or-direct', description: 'List admins', options: [DATA, JSON_OUT] },
	{
		name: 'blocklist add',
		args: ['login'],
		transport: 'socket-or-direct',
		description: 'Block a GitHub login: their issues are closed, even if allowlisted or an owner (ADR 0260)',
		options: [DATA, JSON_OUT, { name: 'for', type: 'string', description: 'Block only for this long, e.g. 1h, 30m, 7d (default: until removed)' }, { name: 'note', type: 'string', description: 'Why (shown in the UI)' }]
	},
	{ name: 'blocklist remove', args: ['login'], transport: 'socket-or-direct', description: 'Unblock a GitHub login', options: [DATA, JSON_OUT] },
	{ name: 'blocklist list', args: [], transport: 'socket-or-direct', description: 'List blocked logins (expired entries marked)', options: [DATA, JSON_OUT] },
	{ name: 'login-link', args: ['login'], transport: 'socket-or-direct', description: 'Print a one-time sign-in URL for an admin', options: [DATA, JSON_OUT, { name: 'ttl', type: 'string', description: 'Validity, e.g. 15m, 2h (max 24h)', default: '15m' }] },
	{ name: 'github status', args: [], transport: 'socket', description: 'Show the GitHub connection, installations and catch-up', options: [DATA, JSON_OUT] },
	{ name: 'github setup-url', args: [], transport: 'socket', description: 'Print the URL of the GitHub setup page', options: [DATA, JSON_OUT, { name: 'login', type: 'string', description: 'Also create a login link for this admin' }] },
	{ name: 'config get', args: ['key'], transport: 'socket-or-direct', description: 'Read an in-product setting (dotted key)', options: [DATA, JSON_OUT] },
	{ name: 'config set', args: ['key', 'value'], transport: 'socket-or-direct', description: 'Write an in-product setting (dotted key, JSON or string value)', options: [DATA, JSON_OUT] },
	{ name: 'config seed', args: [], transport: 'socket-or-direct', description: 'Apply env seeds now (never overwrites edited values)', options: [DATA, JSON_OUT] },
	{ name: 'backup now', args: [], transport: 'socket', description: 'Run a backup plan now', options: [DATA, JSON_OUT, { name: 'plan', type: 'string', description: 'Plan id (default: all enabled plans)' }] },
	{ name: 'backup list', args: [], transport: 'socket', description: 'List recent backup runs', options: [DATA, JSON_OUT] },
	{ name: 'restore', args: [], transport: 'offline', description: 'Restore a backup (see `granary restore --help`, ADR 0115)', options: [DATA] },
	{ name: 'systemd-unit', args: [], transport: 'none', description: 'Print a systemd unit for granary', options: [DATA, { name: 'user', type: 'string', description: 'Service user', default: 'granary' }, { name: 'bin', type: 'string', description: 'Path to the granary binary' }] },
	{ name: 'version', args: [], transport: 'none', description: 'Print granary, Bun and tinyactors versions', options: [DATA, JSON_OUT] }
] as const;

export type CliCommandName = (typeof CLI_COMMANDS)[number]['name'];
