/**
 * Persona catalogue (ADR 0071): chart sources, descriptions, expected
 * outcomes, how each kind is bound when it arrives, and the texts the
 * `host` processor writes for a persona's `draft`. Not an actor.
 */
import type { Source } from '@tinyactors/node';
import type { ExpectedOutcome, PersonaKind } from '../schemas';
import { deriveSeed, Rng } from '../rng';
import * as text from '../text';
import { fuzzCases } from '../fuzz-cases';
import type { DraftRequest, PersonaBinding } from './common';
import { slopFixerChart } from './slop-fixer';
import { persistentContributorChart } from './persistent-contributor';
import { regularChart } from './regular';
import { maintainerChart } from './maintainer';
import { memberChart } from './member';
import { firstTimerChart } from './first-timer';
import { botChart } from './bot';
import { chaosMonkeyChart } from './chaos-monkey';
import { fuzzerChart } from './fuzzer';

export interface PersonaKindSpec {
	kind: PersonaKind;
	title: string;
	description: string;
	expected: ExpectedOutcome;
	/** The kind's SCXML chart (chart name = the kind). */
	chart: Source;
	/** Short login prefix. */
	prefix: string;
	/** Association (and login override) for arrival `index`. */
	identity: (ctx: IdentityContext) => { login?: string; association: string };
}

export interface IdentityContext {
	rng: Rng;
	index: number;
	allowlisted: string[];
}

export const PERSONAS: Record<PersonaKind, PersonaKindSpec> = {
	'slop-fixer': {
		kind: 'slop-fixer',
		title: 'Drive-by slop fixer',
		description: 'Opens 1–3 huge, low-effort issues (walls of generated text, pasted logs, emoji), never replies, vanishes.',
		expected: 'closed',
		chart: slopFixerChart,
		prefix: 'slop',
		identity: () => ({ association: 'NONE' })
	},
	'persistent-contributor': {
		kind: 'persistent-contributor',
		title: 'Persistent annoying contributor',
		description: 'Keeps opening the same request; reopens or re-files after each closure, escalating in tone; rage-quits after 2–4 closures.',
		expected: 'closed',
		chart: persistentContributorChart,
		prefix: 'persist',
		identity: ({ rng }) => ({ association: rng.chance(0.3) ? 'CONTRIBUTOR' : 'NONE' })
	},
	regular: {
		kind: 'regular',
		title: 'Allowlisted regular',
		description: 'A login on the allowlist; opens a few real bug reports and follow-ups. Must never be closed.',
		expected: 'open',
		chart: regularChart,
		prefix: 'regular',
		identity: ({ index, allowlisted }) => ({ login: allowlisted[index % Math.max(1, allowlisted.length)], association: 'NONE' })
	},
	maintainer: {
		kind: 'maintainer',
		title: 'Maintainer',
		description: 'OWNER or COLLABORATOR (not on the allowlist); opens tracking issues. Must never be closed.',
		expected: 'open',
		chart: maintainerChart,
		prefix: 'maint',
		identity: ({ rng }) => ({ association: rng.chance(0.5) ? 'OWNER' : 'COLLABORATOR' })
	},
	member: {
		kind: 'member',
		title: 'Org member',
		description: 'Association MEMBER (not on the allowlist). Must never be closed.',
		expected: 'open',
		chart: memberChart,
		prefix: 'member',
		identity: () => ({ association: 'MEMBER' })
	},
	'first-timer': {
		kind: 'first-timer',
		title: 'First-timer',
		description: 'FIRST_TIME_CONTRIBUTOR; opens one polite issue, replies politely once after it is closed, then waits.',
		expected: 'closed',
		chart: firstTimerChart,
		prefix: 'newbie',
		identity: () => ({ association: 'FIRST_TIME_CONTRIBUTOR' })
	},
	bot: {
		kind: 'bot',
		title: 'Flooding bot',
		description: 'A [bot] account (user type Bot) that opens 5–15 dependabot-style issues in quick succession.',
		expected: 'closed',
		chart: botChart,
		prefix: 'lgbot',
		identity: () => ({ association: 'NONE' })
	},
	'chaos-monkey': {
		kind: 'chaos-monkey',
		title: 'Chaos monkey',
		description: 'Injects REST faults on granary’s calls (500, 503, 403 + Retry-After) and duplicate / burst webhook redeliveries.',
		expected: 'none',
		chart: chaosMonkeyChart,
		prefix: 'chaos',
		identity: () => ({ association: 'NONE' })
	},
	fuzzer: {
		kind: 'fuzzer',
		title: 'Fuzzer',
		description: 'Edge cases: huge/unicode titles and bodies, odd logins and associations, open/reopen races, malformed signed webhooks.',
		expected: 'varies',
		chart: fuzzerChart,
		prefix: 'fz',
		identity: () => ({ association: 'NONE' })
	}
};

/** Binding for arrival `index` of a scenario. */
export function personaBinding(opts: {
	kind: PersonaKind;
	scenarioId: string;
	index: number;
	seed: number;
	timeScale: number;
	allowlisted: string[];
}): PersonaBinding & { name: string } {
	const spec = PERSONAS[opts.kind];
	const rng = new Rng(deriveSeed(opts.seed, opts.index));
	const id = identityFor(spec, rng, opts);
	const name = `${opts.scenarioId}-${String(opts.index + 1).padStart(3, '0')}`;
	let login = id.login ?? `${spec.prefix}-${opts.scenarioId}-${opts.index + 1}`;
	if (opts.kind === 'bot') login = `${login}[bot]`;
	return {
		name,
		id: `${opts.kind}/${name}`,
		kind: opts.kind,
		scenarioId: opts.scenarioId,
		login,
		association: id.association,
		rng: rng.state,
		timeScale: opts.timeScale,
		allowlisted: opts.allowlisted
	};
}

function identityFor(spec: PersonaKindSpec, rng: Rng, o: { index: number; allowlisted: string[] }) {
	return spec.identity({ rng, index: o.index, allowlisted: o.allowlisted });
}

/**
 * The `host` processor's answer to a persona's `draft`: the texts of
 * `loadgen/text.ts` drawn from the persona's RNG state, and the state after.
 */
export function draftText(req: DraftRequest): { rng: number; title?: string; body?: string; cases?: unknown[] } {
	const r = new Rng(req.rng >>> 0);
	const out = (fields: { title?: string; body?: string; cases?: unknown[] }) => ({ ...fields, rng: r.state });
	switch (req.what) {
		case 'slop': {
			const title = text.slopTitle(r);
			return out({ title, body: text.slopBody(r) });
		}
		case 'persistent': {
			const tone = req.tone ?? 0;
			const title = text.persistentTitle(r, tone, req.attempts ?? 1, req.previous ?? null);
			return out({ title, body: text.persistentBody(r, tone) });
		}
		case 'rage-quit':
			return out({ body: text.rageQuit(r) });
		case 'regular': {
			const title = text.regularTitle(r);
			return out({ title, body: text.regularBody(r) });
		}
		case 'maintainer': {
			const title = text.maintainerTitle(r);
			return out({ title, body: text.regularBody(r) });
		}
		case 'follow-up':
			return out({ body: text.followUp(r) });
		case 'first-timer':
			return out({ title: text.firstTimerTitle(r), body: text.firstTimerBody() });
		case 'polite-reply':
			return out({ body: text.politeReply(r) });
		case 'bot': {
			const title = text.botTitle(r);
			return out({ title, body: text.botBody(r) });
		}
		case 'fuzz-cases': {
			const all = fuzzCases({ allowlisted: req.allowlisted ?? [], loginPrefix: req.login ?? 'fz' });
			const shuffled = new Rng(Math.floor(r.float() * 4294967296)).shuffle(all);
			return out({ cases: shuffled.slice(0, Math.min(all.length, r.int(8, 12))) });
		}
	}
}
