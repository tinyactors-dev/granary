/**
 * Scenario presets, config resolution and the seeded arrival plan (ADR 0072).
 */
import {
	PERSONA_KINDS,
	ScenarioConfig,
	type CreateScenarioRequest,
	type PersonaKind,
	type PersonaMix,
	type PresetInfo,
	type PresetName
} from './schemas';
import { issuesOf } from '../src/lib/schemas/standard';
import { Rng } from './rng';

const ALL: PersonaMix = Object.fromEntries(PERSONA_KINDS.map((k) => [k, 1]));

export const DEFAULT_CONFIG: ScenarioConfig = {
	name: 'custom',
	seed: 1,
	mix: { ...ALL, 'chaos-monkey': 0.5 },
	personas: 20,
	arrivalRatePerMin: 30,
	rampUpMs: 10_000,
	durationMs: 60_000,
	timeScale: 0.5,
	closeDeadlineMs: 30_000,
	faultGraceMs: 45_000
};

export const PRESETS: Record<PresetName, { description: string; config: ScenarioConfig }> = {
	smoke: {
		description: 'A quick mixed crowd: one of almost everything, fast think-times. Good first run (≈30 s).',
		config: {
			...DEFAULT_CONFIG,
			name: 'smoke',
			mix: { ...ALL, 'chaos-monkey': 0.5, fuzzer: 0.5 },
			personas: 12,
			arrivalRatePerMin: 60,
			rampUpMs: 5_000,
			durationMs: 30_000,
			timeScale: 0.2
		}
	},
	steady: {
		description: 'A realistic day compressed: mostly trusted users and first-timers, a few pests (5 min).',
		config: {
			...DEFAULT_CONFIG,
			name: 'steady',
			mix: { regular: 4, maintainer: 2, member: 2, 'first-timer': 3, 'persistent-contributor': 1, 'slop-fixer': 1, bot: 0.5 },
			personas: 60,
			arrivalRatePerMin: 15,
			rampUpMs: 30_000,
			durationMs: 300_000,
			timeScale: 1
		}
	},
	'slop-storm': {
		description: 'Hacktoberfest: a wave of drive-by slop and persistent contributors (2 min).',
		config: {
			...DEFAULT_CONFIG,
			name: 'slop-storm',
			mix: { 'slop-fixer': 6, 'persistent-contributor': 3, 'first-timer': 1, regular: 0.5 },
			personas: 80,
			arrivalRatePerMin: 120,
			rampUpMs: 20_000,
			durationMs: 120_000,
			timeScale: 0.3
		}
	},
	'bot-flood': {
		description: 'Several bots opening issues as fast as they can, with a trusted user in between.',
		config: {
			...DEFAULT_CONFIG,
			name: 'bot-flood',
			mix: { bot: 1, regular: 0.2 },
			personas: 12,
			arrivalRatePerMin: 60,
			rampUpMs: 2_000,
			durationMs: 30_000,
			timeScale: 0.1
		}
	},
	chaos: {
		description: 'Mixed crowd while chaos monkeys break GitHub’s API and duplicate webhooks.',
		config: {
			...DEFAULT_CONFIG,
			name: 'chaos',
			mix: { 'chaos-monkey': 2, 'slop-fixer': 2, 'first-timer': 2, regular: 1, maintainer: 1, 'persistent-contributor': 1 },
			personas: 30,
			arrivalRatePerMin: 40,
			durationMs: 60_000,
			timeScale: 0.3,
			faultGraceMs: 60_000
		}
	},
	fuzz: {
		description: 'Fuzzers working through edge cases, next to allowlisted regulars.',
		config: {
			...DEFAULT_CONFIG,
			name: 'fuzz',
			mix: { fuzzer: 3, regular: 1 },
			personas: 8,
			arrivalRatePerMin: 30,
			rampUpMs: 2_000,
			durationMs: 30_000,
			timeScale: 0.2
		}
	}
};

export const presetInfos = (): PresetInfo[] =>
	(Object.keys(PRESETS) as PresetName[]).map((name) => ({ name, description: PRESETS[name].description, config: PRESETS[name].config }));

export class ConfigProblem extends Error {
	constructor(
		message: string,
		readonly issues: { message: string; path: (string | number)[] }[] = []
	) {
		super(message);
	}
}

/** Preset (or default) + patch, validated. `mix` in the patch replaces the preset's. */
export function resolveConfig(req: CreateScenarioRequest): ScenarioConfig {
	const base = req.preset ? PRESETS[req.preset].config : DEFAULT_CONFIG;
	const merged: ScenarioConfig = { ...base, ...(req.config ?? {}) } as ScenarioConfig;
	if (req.config?.mix) merged.mix = { ...req.config.mix };
	if (!req.config?.name && req.preset) merged.name = req.preset;
	const issues = issuesOf(ScenarioConfig, merged);
	if (issues.length) throw new ConfigProblem('Invalid scenario config', issues);
	return merged;
}

export interface Arrival {
	index: number;
	atMs: number;
	kind: PersonaKind;
}

/** Seeded arrival plan: exponential gaps under a linearly ramped rate, weighted kinds. */
export function buildPlan(config: ScenarioConfig, opts: { allowlisted: string[] }): Arrival[] {
	const weights = PERSONA_KINDS.map((k) => {
		let w = config.mix[k] ?? 0;
		if (k === 'regular' && opts.allowlisted.length === 0) w = 0;
		return [k, Math.max(0, w)] as const;
	}).filter(([, w]) => w > 0);
	const total = weights.reduce((s, [, w]) => s + w, 0);
	if (total <= 0) throw new ConfigProblem('The persona mix is empty (all weights are 0).');
	const rng = new Rng(config.seed >>> 0 || 1);
	const out: Arrival[] = [];
	let t = 0;
	for (let i = 0; i < config.personas; i++) {
		const ramp = config.rampUpMs > 0 ? Math.min(1, t / config.rampUpMs) : 1;
		const perMs = (config.arrivalRatePerMin * (0.1 + 0.9 * ramp)) / 60_000;
		const gap = i === 0 ? 0 : -Math.log(1 - rng.float()) / perMs;
		t += gap;
		if (t > config.durationMs) break;
		let x = rng.float() * total;
		let kind = weights[weights.length - 1]![0];
		for (const [k, w] of weights) {
			if (x < w) {
				kind = k;
				break;
			}
			x -= w;
		}
		out.push({ index: i, atMs: Math.round(t), kind });
	}
	return out;
}
