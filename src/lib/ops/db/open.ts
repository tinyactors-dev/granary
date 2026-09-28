/**
 * Open and migrate ops.sqlite (ADR 0089, 0230). Shared by all features.
 */
import { Database } from 'bun:sqlite';
import { OPS_APPLICATION_ID, OPS_MIGRATIONS, OPS_PRAGMAS } from './ddl';

export function openOpsDb(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	for (const p of OPS_PRAGMAS) db.exec(p);
	migrate(db);
	return db;
}

export function migrate(db: Database): number {
	const row = db.query('PRAGMA user_version').get() as { user_version: number };
	const app = db.query('PRAGMA application_id').get() as { application_id: number };
	let v = row.user_version;
	if (v > 0 && app.application_id !== OPS_APPLICATION_ID) {
		throw new Error(`${db.filename} has a pre-release layout (ADR 0230); remove it (and its -wal/-shm files) and start again`);
	}
	for (; v < OPS_MIGRATIONS.length; v++) {
		db.transaction(() => {
			db.exec(OPS_MIGRATIONS[v]!);
			db.exec(`PRAGMA user_version = ${v + 1}`);
			if (v === 0) db.exec(`PRAGMA application_id = ${OPS_APPLICATION_ID}`);
		})();
	}
	return v;
}
