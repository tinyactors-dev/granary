/**
 * Source of the snapshot Worker (ADR 0083, 0098, 0113).
 *
 * Kept as a self-contained JavaScript string and started from a Blob URL so it
 * survives any bundler (Vite/adapter-bun, `bun build`) without needing a
 * separate worker entry file next to the server chunks. It only uses Bun
 * built-ins (`bun:sqlite`, `Bun.file`, `Bun.CryptoHasher`, `node:fs`).
 *
 * Jobs (one at a time, answered by `id`):
 *   {id, type:'snapshot', dbPath, outPath}
 *       VACUUM INTO '<outPath>.partial' on its own connection → rename →
 *       open read-only → integrity_check (must be ok) → facts + sha256.
 *   {id, type:'check', path}
 *       open read-only → integrity_check → facts (restore drills, CLI).
 * Replies: {id, ok:true, facts} | {id, ok:false, reason, detail}.
 */
export const SNAPSHOT_WORKER_SOURCE = String.raw`
const { renameSync, rmSync, statSync } = require('node:fs');

async function sha256File(path) {
	const h = new Bun.CryptoHasher('sha256');
	const reader = Bun.file(path).stream().getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (value) h.update(value);
		if (done) break;
	}
	return h.digest('hex');
}

async function facts(Database, path, withHash) {
	const db = new Database(path, { readonly: true });
	try {
		const ic = db.query('PRAGMA integrity_check').all().map((r) => r.integrity_check);
		if (!(ic.length === 1 && ic[0] === 'ok')) return { ok: false, reason: 'integrity', detail: 'integrity_check: ' + ic.slice(0, 5).join('; ') };
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
		const rowCounts = {};
		for (const t of tables) rowCounts[t] = db.query('SELECT count(*) AS n FROM "' + t.replaceAll('"', '""') + '"').get().n;
		const out = {
			sqliteVersion: db.query('SELECT sqlite_version() AS v').get().v,
			userVersion: db.query('PRAGMA user_version').get().user_version,
			pageCount: db.query('PRAGMA page_count').get().page_count,
			rowCounts
		};
		db.close();
		out.rawBytes = statSync(path).size;
		if (withHash) out.rawSha256 = await sha256File(path);
		return { ok: true, facts: out };
	} catch (e) {
		try { db.close(); } catch {}
		return { ok: false, reason: 'sqlite-error', detail: String(e && e.message || e) };
	}
}

self.onmessage = async (event) => {
	const job = event.data;
	const { Database } = await import('bun:sqlite');
	try {
		if (job.type === 'snapshot') {
			const partial = job.outPath + '.partial';
			rmSync(partial, { force: true });
			let src;
			try {
				src = new Database(job.dbPath, { readwrite: true });
				src.exec('PRAGMA busy_timeout = 5000');
				src.exec("VACUUM INTO '" + partial.replaceAll("'", "''") + "'");
			} catch (e) {
				rmSync(partial, { force: true });
				const msg = String(e && e.message || e);
				postMessage({ id: job.id, ok: false, reason: /full|SQLITE_FULL|ENOSPC|disk/i.test(msg) ? 'disk-insufficient' : 'sqlite-error', detail: msg });
				return;
			} finally {
				try { src && src.close(); } catch {}
			}
			renameSync(partial, job.outPath);
			const r = await facts(Database, job.outPath, true);
			if (!r.ok) rmSync(job.outPath, { force: true });
			postMessage({ id: job.id, ...r });
		} else if (job.type === 'check') {
			postMessage({ id: job.id, ...(await facts(Database, job.path, false)) });
		} else {
			postMessage({ id: job.id, ok: false, reason: 'sqlite-error', detail: 'unknown job type ' + job.type });
		}
	} catch (e) {
		postMessage({ id: job.id, ok: false, reason: 'sqlite-error', detail: String(e && e.message || e) });
	}
};
`;
