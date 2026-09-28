/**
 * Open and migrate ops.sqlite (ADR 0089, 0109). Shared by all features;
 * pinned in M0 so the backups and health agents can start in parallel.
 */
import { Database } from 'bun:sqlite';
import { OPS_MIGRATIONS, OPS_PRAGMAS } from './ddl';

export function openOpsDb(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	for (const p of OPS_PRAGMAS) db.exec(p);
	migrate(db);
	return db;
}

export function migrate(db: Database): number {
	const row = db.query('PRAGMA user_version').get() as { user_version: number };
	let v = row.user_version;
	for (; v < OPS_MIGRATIONS.length; v++) {
		db.transaction(() => {
			db.exec(OPS_MIGRATIONS[v]!);
			db.exec(`PRAGMA user_version = ${v + 1}`);
		})();
	}
	return v;
}
