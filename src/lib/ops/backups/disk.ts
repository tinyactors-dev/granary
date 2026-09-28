/**
 * Disk facts and the backup space rule (ADR 0098).
 * `OPS_TEST_STATFS_OVERRIDE=<free>/<total>` replaces statfs in tests (ADR 0103).
 */
import { statfs } from 'node:fs/promises';
import type { Budgets } from '../schemas/budgets';

export interface DiskFacts {
	freeBytes: number;
	totalBytes: number;
	overridden: boolean;
}

export async function diskFacts(dir: string, env: Record<string, string | undefined>): Promise<DiskFacts> {
	const o = env.OPS_TEST_STATFS_OVERRIDE;
	if (o && /^\d+\/\d+$/.test(o)) {
		const [free, total] = o.split('/').map(Number) as [number, number];
		return { freeBytes: free, totalBytes: total, overridden: true };
	}
	const s = await statfs(dir);
	return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize), overridden: false };
}

/** Minimum free space that must remain after a snapshot of `dbBytes` (ADR 0098). */
export const requiredHeadroom = (d: DiskFacts, b: Budgets) => Math.max(b.disk.minFreeBytes, b.disk.minFreeRatio * d.totalBytes);

/** A backup starts only if free − dbSize ≥ max(minFreeBytes, minFreeRatio × total). */
export function snapshotAllowed(d: DiskFacts, dbBytes: number, b: Budgets): { ok: boolean; detail: string } {
	const need = requiredHeadroom(d, b);
	const after = d.freeBytes - dbBytes;
	return {
		ok: after >= need,
		detail: `free ${fmt(d.freeBytes)} − db ${fmt(dbBytes)} = ${fmt(after)} (need ≥ ${fmt(need)} of ${fmt(d.totalBytes)})`
	};
}

/** The single local copy is kept only while free after it ≥ localCopyMinFreeRatio × total. */
export function localCopyAllowed(d: DiskFacts, copyBytes: number, b: Budgets): { ok: boolean; detail: string } {
	const need = b.disk.localCopyMinFreeRatio * d.totalBytes;
	const after = d.freeBytes - copyBytes;
	return { ok: after >= need, detail: `free after local copy ${fmt(after)} (need ≥ ${fmt(need)})` };
}

export function fmt(n: number): string {
	const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let i = 0;
	let v = n;
	while (Math.abs(v) >= 1024 && i < u.length - 1) (v /= 1024), i++;
	return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
