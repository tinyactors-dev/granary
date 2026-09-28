#!/usr/bin/env bun
/**
 * `granary` — the command-line entry point (ADR 0156, 0159). Built to
 * `dist/cli.js` by `mise run cli`; the package's `bin`.
 */
import { EXIT } from '../lib/schemas/cli';
import { UsageError, parseArgs, usage } from './args';
import * as cmd from './commands';
import { CliError, createContext, requireDataDir } from './context';
import { init, restore, serve } from './lifecycle';

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ('help' in parsed) {
		console.log(usage(parsed.topic));
		return EXIT.ok;
	}
	const ctx = createContext(parsed.options);
	// ADR 0232: every command that touches a data dir checks it first and never
	// creates state outside `init`/`serve`; restore checks inside (its direct
	// disaster-recovery mode needs no data dir).
	switch (parsed.command.name) {
		case 'init':
			requireDataDir(ctx, { allowMissing: true, allowUninitialised: true });
			break;
		case 'serve':
			requireDataDir(ctx, { allowUninitialised: true });
			break;
		case 'restore':
		case 'systemd-unit':
		case 'version':
			break;
		default:
			requireDataDir(ctx);
	}
	switch (parsed.command.name) {
		case 'serve':
			return serve(ctx, parsed);
		case 'init':
			return init(ctx, parsed);
		case 'restore':
			return restore(ctx, parsed);
		case 'doctor':
			return cmd.doctor(ctx);
		case 'admin add':
			await cmd.adminAdd(ctx, parsed);
			return EXIT.ok;
		case 'admin remove':
			await cmd.adminRemove(ctx, parsed);
			return EXIT.ok;
		case 'admin list':
			await cmd.adminList(ctx);
			return EXIT.ok;
		case 'login-link':
			await cmd.loginLink(ctx, parsed);
			return EXIT.ok;
		case 'github status':
			await cmd.githubStatus(ctx);
			return EXIT.ok;
		case 'github setup-url':
			await cmd.githubSetupUrl(ctx, parsed);
			return EXIT.ok;
		case 'config get':
			await cmd.configGetCmd(ctx, parsed);
			return EXIT.ok;
		case 'config set':
			await cmd.configSetCmd(ctx, parsed);
			return EXIT.ok;
		case 'config seed':
			await cmd.configSeed(ctx);
			return EXIT.ok;
		case 'backup now':
			await cmd.backupNow(ctx, parsed);
			return EXIT.ok;
		case 'backup list':
			await cmd.backupList(ctx);
			return EXIT.ok;
		case 'systemd-unit':
			process.stdout.write(cmd.systemdUnit(parsed));
			return EXIT.ok;
		case 'version':
			await cmd.version(ctx);
			return EXIT.ok;
	}
	throw new UsageError(`unhandled command ${parsed.command.name}`);
}

main(process.argv.slice(2)).then(
	(code) => {
		if (code >= 0) process.exit(code);
	},
	(e: unknown) => {
		if (e instanceof UsageError) {
			console.error(`granary: ${e.message}\nRun \`granary --help\` for usage.`);
			process.exit(EXIT.usage);
		}
		if (e instanceof CliError) {
			console.error(`granary: ${e.message}`);
			process.exit(e.exitCode);
		}
		console.error('granary:', e instanceof Error ? (e.stack ?? e.message) : e);
		process.exit(EXIT.error);
	}
);
