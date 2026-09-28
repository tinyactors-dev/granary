/**
 * Text the personas write (ADR 0071). Deterministic given a RandomSource.
 * Deliberately recognisable: slop reads like slop, anger escalates.
 */
import type { RandomSource } from './rng';

const pick = <T>(r: RandomSource, xs: readonly T[]): T => xs[Math.floor(r.float() * xs.length)]!;
const int = (r: RandomSource, min: number, max: number) => min + Math.floor(r.float() * (max - min + 1));

const AREAS = ['parser', 'CLI', 'config loader', 'cache', 'plugin API', 'docs', 'installer', 'test suite', 'logging', 'retry logic'];
const EMOJI = ['🚀', '🔥', '✨', '💯', '🙏', '⚡', '🤖', '🐛', '💡', '📈', '✅', '❗'];
const BUZZ = [
	'leverage', 'robust', 'seamless', 'holistic', 'scalable', 'best-in-class', 'synergy', 'paradigm',
	'cutting-edge', 'streamline', 'empower', 'future-proof', 'delve', 'tapestry', 'crucial'
];

function emojis(r: RandomSource, n: number) {
	return Array.from({ length: n }, () => pick(r, EMOJI)).join('');
}

// -- slop fixer ---------------------------------------------------------------

export function slopTitle(r: RandomSource): string {
	const t = pick(r, [
		`${emojis(r, 2)} Comprehensive Refactor Proposal: ${pick(r, BUZZ)} ${pick(r, AREAS)} Overhaul ${emojis(r, 2)}`,
		`[URGENT] Fixed ALL the issues in ${pick(r, AREAS)} (please merge asap)`,
		`Improve code quality across entire codebase ${emojis(r, 3)}`,
		`${pick(r, AREAS)} is broken?? + 47 other improvements I found`,
		`AI-assisted audit of ${pick(r, AREAS)}: ${int(r, 12, 99)} critical findings`
	]);
	return t.slice(0, 240);
}

export function slopBody(r: RandomSource): string {
	const parts: string[] = [];
	parts.push(`## Summary ${emojis(r, 3)}\n`);
	const paragraphs = int(r, 6, 20);
	for (let i = 0; i < paragraphs; i++) {
		const words = Array.from({ length: int(r, 40, 120) }, () => pick(r, BUZZ)).join(' ');
		parts.push(`In today's fast-paced landscape, it is crucial to ${words}. ${emojis(r, int(r, 0, 4))}\n`);
	}
	parts.push('## Logs\n```');
	const lines = int(r, 80, 600);
	for (let i = 0; i < lines; i++) {
		parts.push(
			`2026-09-28T08:${String(int(r, 0, 59)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')}Z ERROR [${pick(r, AREAS)}] ` +
				`java.lang.NullPointerException at com.example.${pick(r, BUZZ)}.Handler(Handler.java:${int(r, 1, 9999)})`
		);
	}
	parts.push('```\n## Steps to reproduce\nidk it just happens\n\n## Checklist\n' + '- [x] I have read the docs (skimmed)\n'.repeat(int(r, 3, 12)));
	return parts.join('\n').slice(0, 60_000);
}

// -- persistent contributor ----------------------------------------------------

const TONES = ['polite', 'insistent', 'annoyed', 'furious'] as const;
export const toneName = (tone: number) => TONES[Math.min(tone, TONES.length - 1)]!;

export function persistentTitle(r: RandomSource, tone: number, attempt: number, previous: string | null): string {
	const base = previous ?? `Please add ${pick(r, ['dark mode', 'YAML support', 'a --force flag', 'Windows 98 support', 'blockchain integration'])} to the ${pick(r, AREAS)}`;
	const stripped = base.replace(/^(\[.*?\]\s*|Re: |AGAIN: )+/g, '');
	switch (Math.min(tone, 3)) {
		case 0:
			return stripped;
		case 1:
			return `Re: ${stripped} (opened again, #${attempt})`;
		case 2:
			return `AGAIN: ${stripped} — why was this closed???`;
		default:
			return `[${attempt}th TIME] ${stripped.toUpperCase()}`.slice(0, 240);
	}
}

export function persistentBody(r: RandomSource, tone: number): string {
	switch (Math.min(tone, 3)) {
		case 0:
			return 'Hi! I think this would be a great addition. Happy to discuss. Thanks!';
		case 1:
			return 'My previous issue was closed without discussion. I am opening it again because this is important.';
		case 2:
			return `This is the ${int(r, 3, 9)}th project that ignores its users. Closing issues automatically is disrespectful.`;
		default:
			return 'I WILL KEEP OPENING THIS UNTIL SOMEONE RESPONDS. '.repeat(int(r, 3, 12));
	}
}

export function rageQuit(r: RandomSource): string {
	return pick(r, [
		'Fine. I am forking this project. Good luck with your "community".',
		'Unsubscribing. Worst maintainers ever. 1/10.',
		'Reported to GitHub. This is censorship.'
	]);
}

// -- trusted users ----------------------------------------------------------------

export function regularTitle(r: RandomSource): string {
	return pick(r, [
		`${pick(r, AREAS)}: crash when input is empty`,
		`Document the ${pick(r, AREAS)} timeout option`,
		`Flaky test in ${pick(r, AREAS)} on macOS`,
		`${pick(r, AREAS)} ignores XDG_CONFIG_HOME`
	]);
}

export function regularBody(r: RandomSource): string {
	return `Steps:\n1. run \`tool ${pick(r, ['sync', 'build', 'check'])}\`\n2. observe the error\n\nVersion: 2.${int(r, 0, 9)}.${int(r, 0, 20)}`;
}

export function maintainerTitle(r: RandomSource): string {
	return pick(r, [
		`Release 2.${int(r, 1, 9)} checklist`,
		`Tracking: deprecate old ${pick(r, AREAS)} API`,
		`RFC: restructure ${pick(r, AREAS)}`,
		`CI: move ${pick(r, AREAS)} jobs to the new runners`
	]);
}

export function followUp(r: RandomSource): string {
	return pick(r, ['Adding a stack trace from CI.', 'Bisected to the last release.', 'Workaround: set the env var.', 'Any objections?']);
}

// -- first timer -----------------------------------------------------------------

export function firstTimerTitle(r: RandomSource): string {
	return pick(r, [
		`How do I install this on ${pick(r, ['Ubuntu', 'my Mac', 'Windows'])}?`,
		`Small typo in the README`,
		`Question about the ${pick(r, AREAS)}`
	]);
}

export function firstTimerBody(): string {
	return 'Hi, this is my first issue on GitHub, sorry if I am doing it wrong! 😊';
}

export function politeReply(r: RandomSource): string {
	return pick(r, [
		'Oh, I did not know issues were restricted — sorry and thank you!',
		'Understood, I will ask in the discussions instead. Thanks for the project!',
		'No worries, thanks for the quick answer 🙏'
	]);
}

// -- bot -------------------------------------------------------------------------

const PACKAGES = ['lodash', 'left-pad', 'express', 'typescript', 'vite', 'react', 'zod', 'axios', 'chalk', 'debug'];

export function botTitle(r: RandomSource): string {
	const p = pick(r, PACKAGES);
	const major = int(r, 1, 9);
	return `Bump ${p} from ${major}.${int(r, 0, 9)}.${int(r, 0, 9)} to ${major + int(r, 0, 1)}.${int(r, 0, 9)}.${int(r, 0, 9)}`;
}

export function botBody(r: RandomSource): string {
	return `Bumps a dependency.\n\n<details><summary>Release notes</summary>\n\n${'- fixes\n'.repeat(int(r, 3, 30))}</details>\n\nDependabot will resolve any conflicts with this PR as long as you don't alter it yourself.`;
}
