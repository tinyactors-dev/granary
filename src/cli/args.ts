/**
 * Argument parsing driven by the pinned command catalogue (`CLI_COMMANDS`,
 * ADR 0159): the longest command name that prefixes argv wins; options are
 * `--name value`, `--name=value` or boolean `--flag`.
 */
import { CLI_COMMANDS, type CliCommand } from '../lib/schemas/cli';

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

export interface Parsed {
	command: CliCommand;
	args: string[];
	options: Record<string, string | boolean>;
	/** Everything after the command for pass-through commands (`restore`). */
	rest: string[];
}

/** Commands whose options are parsed by the delegate, not here. */
const PASS_THROUGH = new Set(['restore']);

export function findCommand(argv: string[]): { command: CliCommand; consumed: number } | null {
	let best: { command: CliCommand; consumed: number } | null = null;
	for (const c of CLI_COMMANDS) {
		const words = c.name.split(' ');
		if (words.every((w, i) => argv[i] === w) && (!best || words.length > best.consumed)) best = { command: c, consumed: words.length };
	}
	return best;
}

export function parseArgs(argv: string[]): Parsed | { help: true; topic: string | null } {
	if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return { help: true, topic: argv.slice(1).join(' ') || null };
	const found = findCommand(argv);
	if (!found) throw new UsageError(`unknown command: ${argv.slice(0, 2).join(' ')}`);
	const { command } = found;
	const tail = argv.slice(found.consumed);
	if (tail.includes('--help') || tail.includes('-h')) {
		if (!PASS_THROUGH.has(command.name)) return { help: true, topic: command.name };
	}
	const options: Record<string, string | boolean> = {};
	const args: string[] = [];
	const rest: string[] = [];
	const byName = new Map(command.options.map((o) => [o.name, o]));
	for (let i = 0; i < tail.length; i++) {
		const t = tail[i]!;
		if (t.startsWith('--')) {
			const eq = t.indexOf('=');
			const name = eq > 0 ? t.slice(2, eq) : t.slice(2);
			const opt = byName.get(name);
			if (!opt) {
				if (PASS_THROUGH.has(command.name)) {
					rest.push(t);
					continue;
				}
				throw new UsageError(`unknown option --${name} for \`granary ${command.name}\``);
			}
			if (opt.type === 'boolean') {
				if (eq > 0) throw new UsageError(`--${name} takes no value`);
				options[name] = true;
			} else {
				const v = eq > 0 ? t.slice(eq + 1) : tail[++i];
				if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
				options[name] = v;
			}
		} else if (PASS_THROUGH.has(command.name)) {
			rest.push(t);
		} else {
			args.push(t);
		}
	}
	if (!PASS_THROUGH.has(command.name)) {
		if (args.length < command.args.length) throw new UsageError(`missing <${command.args[args.length]}> for \`granary ${command.name}\``);
		if (args.length > command.args.length) throw new UsageError(`unexpected argument ${JSON.stringify(args[command.args.length])} for \`granary ${command.name}\``);
	}
	for (const o of command.options) if (options[o.name] === undefined && o.default !== undefined) options[o.name] = o.type === 'boolean' ? o.default === 'true' : o.default;
	return { command, args, options, rest };
}

export function usage(topic: string | null): string {
	if (topic) {
		const c = CLI_COMMANDS.find((x) => x.name === topic);
		if (c) {
			const head = `granary ${c.name}${c.args.map((a) => ` <${a}>`).join('')}${c.options.length ? ' [options]' : ''}`;
			const opts = c.options.map((o) => `  --${o.name}${o.type === 'string' ? ' <value>' : ''}`.padEnd(30) + o.description + (o.default ? ` (default ${o.default})` : ''));
			return [head, '', c.description, ...(opts.length ? ['', 'Options:', ...opts] : [])].join('\n');
		}
	}
	const width = Math.max(...CLI_COMMANDS.map((c) => (c.name + c.args.map((a) => ` <${a}>`).join('')).length)) + 2;
	return [
		'granary — keeps GitHub issues from unknown users out, and your data backed up.',
		'',
		'Usage: granary <command> [options]',
		'',
		'Commands:',
		...CLI_COMMANDS.map((c) => `  ${(c.name + c.args.map((a) => ` <${a}>`).join('')).padEnd(width)}${c.description}`),
		'',
		'Run `granary <command> --help` for its options. Data directory: --data, else',
		'GRANARY_DATA_DIR, $XDG_STATE_HOME/granary, ~/.local/state/granary.'
	].join('\n');
}
