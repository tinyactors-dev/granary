/**
 * `granary doctor` checks (ADR 0159) that need no running server: Bun
 * version, data dir permissions, master key, database integrity, disk space,
 * ORIGIN. The admin socket adds server-side checks (system, GitHub, ops).
 * No SvelteKit imports — the CLI runs these offline.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from '../schemas/admin-socket';
import { DATA_DIR_LAYOUT, MIN_BUN_VERSION } from '../schemas/cli';
import { decodeKeyMaterial, firstEnv, MASTER_KEY_FILE } from '../platform/secrets/keys';
import { MASTER_KEY_ENV } from '../platform/secrets/contract';

/** `a >= b` for dotted numeric versions. */
export function versionAtLeast(a: string, b: string): boolean {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

const fmtBytes = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GiB` : `${(n / 2 ** 20).toFixed(0)} MiB`);

export function checkBun(): DoctorCheck {
	const v = Bun.version;
	return versionAtLeast(v, MIN_BUN_VERSION)
		? { name: 'bun', status: 'ok', detail: `Bun ${v}` }
		: { name: 'bun', status: 'fail', detail: `Bun ${v} is older than the required ${MIN_BUN_VERSION}` };
}

export function checkDataDir(dataDir: string): DoctorCheck {
	if (!existsSync(dataDir)) return { name: 'data-dir', status: 'fail', detail: `${dataDir} does not exist (run \`granary init --data ${dataDir}\`)` };
	const mode = statSync(dataDir).mode & 0o777;
	if (mode & 0o077) return { name: 'data-dir', status: 'warn', detail: `${dataDir} is mode ${mode.toString(8)}; expected 700 (chmod 700 ${dataDir})` };
	return { name: 'data-dir', status: 'ok', detail: `${dataDir} (mode 700)` };
}

export function checkMasterKey(env: Record<string, string | undefined>, dataDir: string): DoctorCheck {
	const fromEnv = firstEnv(env, MASTER_KEY_ENV.current);
	const file = join(dataDir, MASTER_KEY_FILE);
	try {
		if (fromEnv) {
			decodeKeyMaterial(fromEnv[1], fromEnv[0]);
			return { name: 'master-key', status: 'ok', detail: `from ${fromEnv[0]}` };
		}
		if (existsSync(file)) {
			decodeKeyMaterial(readFileSync(file, 'utf8'), file);
			const mode = statSync(file).mode & 0o777;
			if (mode & 0o077) return { name: 'master-key', status: 'warn', detail: `${file} is mode ${mode.toString(8)}; expected 600` };
			return { name: 'master-key', status: 'ok', detail: `from ${file}` };
		}
	} catch (e) {
		return { name: 'master-key', status: 'fail', detail: e instanceof Error ? e.message : String(e) };
	}
	return {
		name: 'master-key',
		status: 'fail',
		detail: 'no master key (GRANARY_MASTER_KEY or <data>/master.key): secrets and backups are disabled — run `granary init`'
	};
}

export function checkDatabase(path: string, label: string): DoctorCheck {
	if (!existsSync(path)) return { name: `database:${label}`, status: 'warn', detail: `${path} does not exist yet (created on first start)` };
	let db: Database | null = null;
	try {
		db = new Database(path, { readonly: true });
		const r = db.query('PRAGMA quick_check').get() as Record<string, string> | null;
		const v = r ? Object.values(r)[0] : 'no result';
		return v === 'ok'
			? { name: `database:${label}`, status: 'ok', detail: `${path}: quick_check ok` }
			: { name: `database:${label}`, status: 'fail', detail: `${path}: ${v}` };
	} catch (e) {
		return { name: `database:${label}`, status: 'fail', detail: `${path}: ${e instanceof Error ? e.message : String(e)}` };
	} finally {
		db?.close();
	}
}

export function checkDisk(dataDir: string): DoctorCheck {
	try {
		const s = statfsSync(dataDir);
		const free = s.bavail * s.bsize;
		const total = s.blocks * s.bsize;
		const pct = total ? (free / total) * 100 : 100;
		const detail = `${fmtBytes(free)} free of ${fmtBytes(total)} (${pct.toFixed(0)}%)`;
		return pct < 10 || free < 2 ** 30 ? { name: 'disk', status: 'warn', detail } : { name: 'disk', status: 'ok', detail };
	} catch (e) {
		return { name: 'disk', status: 'warn', detail: e instanceof Error ? e.message : String(e) };
	}
}

export function checkOrigin(origin: string | null | undefined): DoctorCheck {
	if (!origin) return { name: 'origin', status: 'warn', detail: 'ORIGIN is not set: links and the GitHub App webhook URL need the public URL' };
	if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin))
		return { name: 'origin', status: 'warn', detail: `${origin} is not https: GitHub requires a public https webhook URL` };
	return { name: 'origin', status: 'ok', detail: origin };
}

/** All offline checks for a data dir. */
export function offlineChecks(opts: { dataDir: string; env: Record<string, string | undefined>; origin: string | null }): DoctorCheck[] {
	return [
		checkBun(),
		checkDataDir(opts.dataDir),
		checkMasterKey(opts.env, opts.dataDir),
		checkDatabase(join(opts.dataDir, DATA_DIR_LAYOUT.database), 'granary'),
		checkDatabase(join(opts.dataDir, DATA_DIR_LAYOUT.opsDatabase), 'ops'),
		checkDisk(opts.dataDir),
		checkOrigin(opts.origin)
	];
}
