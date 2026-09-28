/**
 * Load generator against the running system (ADR 0070–0074): a short,
 * seeded mixed-persona scenario drives granary through the fake GitHub; the
 * loadgen's own observer must report zero invariant violations, and the
 * app's traces must show every persona issue's actor reaching the expected
 * final state (allowed / closed).
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { useHarness } from './harness';
import { actorFinished, issueAddress } from './traces';
import { parse } from '../src/lib/schemas/standard';
import { LOADGEN_PATHS, PersonaDetail, PersonaSummary, ScenarioDetail, ScenarioSummary } from '../loadgen/schemas';

const h = useHarness({ loadgen: true });

async function api<T>(path: string, schema: Parameters<typeof parse>[0], init?: RequestInit): Promise<T> {
	const res = await fetch(`${h().loadgenUrl}${path}`, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body)}`);
	return parse(schema, body, path) as T;
}

describe('load generator', () => {
	test(
		'mixed seeded scenario: zero invariant violations, traces agree with the oracle',
		async () => {
			const created = await api<ScenarioSummary>(LOADGEN_PATHS.scenarios, ScenarioSummary, {
				method: 'POST',
				body: JSON.stringify({
					preset: 'smoke',
					start: true,
					config: {
						seed: 20260928,
						personas: 10,
						arrivalRatePerMin: 90,
						rampUpMs: 2000,
						durationMs: 15_000,
						timeScale: 0.1,
						closeDeadlineMs: 20_000,
						faultGraceMs: 20_000,
						mix: {
							'slop-fixer': 1,
							'persistent-contributor': 1,
							regular: 1,
							maintainer: 1,
							member: 1,
							'first-timer': 1,
							bot: 0.5,
							'chaos-monkey': 0.5,
							fuzzer: 0.5
						}
					}
				})
			});

			const detail = await h().waitFor(
				async () => {
					const d = await api<ScenarioDetail>(LOADGEN_PATHS.scenario(created.id), ScenarioDetail);
					return d.summary.state === 'finished' || d.summary.state === 'stopped' ? d : null;
				},
				{ timeout: 110_000, interval: 1000, message: `scenario ${created.id} to finish` }
			);

			expect(detail.summary.state).toBe('finished');
			const violations = detail.violations.map((v) => `[${v.invariant}] ${v.message}`);
			expect(violations).toEqual([]);
			expect(detail.invariants.every((i) => i.status === 'ok')).toBe(true);
			expect(detail.metrics.issuesOpened).toBeGreaterThan(5);
			expect(detail.metrics.personaErrors).toBe(0);

			// Every persona issue's granary actor reached the state the oracle expects.
			const personas = await api<PersonaSummary[]>(`${LOADGEN_PATHS.personas}?scenarioId=${created.id}`, Type.Array(PersonaSummary));
			expect(personas.length).toBe(detail.summary.personasArrived);
			let checked = 0;
			for (const p of personas) {
				const d = await api<PersonaDetail>(LOADGEN_PATHS.persona(p.kind, p.name), PersonaDetail);
				for (const issue of d.issues) {
					const address = issueAddress(issue.repoId, issue.number);
					await h().waitForSpan(actorFinished(address, issue.expected === 'open' ? 'allowed' : 'closed'), {
						timeout: 10_000,
						message: `${p.id} #${issue.number} → ${issue.expected === 'open' ? 'allowed' : 'closed'}`
					});
					checked++;
				}
			}
			expect(checked).toBe(detail.metrics.issuesOpened);
		},
		150_000
	);
});
