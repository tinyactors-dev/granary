/**
 * Seeded randomness (ADR 0071, 0072). mulberry32: a 32-bit state that lives
 * in a persona's data model, so a scenario seed reproduces every choice.
 */

/** Advance `state`; returns [float in [0,1), next state]. */
export function step(state: number): [number, number] {
	const t = (state + 0x6d2b79f5) >>> 0;
	let r = Math.imul(t ^ (t >>> 15), t | 1);
	r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
	return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

/** A well-mixed seed for item `index` of a run seeded with `seed`. */
export function deriveSeed(seed: number, index: number): number {
	let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return (h ^ (h >>> 16)) >>> 0;
}

/** A small mutable generator (for code outside actors: plans, text). */
export class Rng {
	constructor(public state: number) {}
	float(): number {
		const [v, s] = step(this.state);
		this.state = s;
		return v;
	}
	int(min: number, max: number): number {
		return min + Math.floor(this.float() * (max - min + 1));
	}
	chance(p: number): boolean {
		return this.float() < p;
	}
	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.float() * items.length)]!;
	}
	shuffle<T>(items: readonly T[]): T[] {
		const a = [...items];
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(this.float() * (i + 1));
			[a[i], a[j]] = [a[j]!, a[i]!];
		}
		return a;
	}
}

/** Anything that yields floats in [0,1). */
export type RandomSource = { float(): number };
