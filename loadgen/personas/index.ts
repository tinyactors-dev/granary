/**
 * Persona catalogue (ADR 0071): chart builders, descriptions, expected
 * outcomes and how each kind is bound when it arrives. Not an actor.
 */
import type { DefinitionBuilder } from '@tinyactors/node';
import type { ExpectedOutcome, PersonaKind } from '../schemas';
import { deriveSeed, Rng } from '../rng';
import type { PersonaBinding } from './common';
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	chart: () => DefinitionBuilder<any>;
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
