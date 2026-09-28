/**
 * Headless scenario run (ADR 0070): `mise run load:run -- --preset smoke --seed 7`.
 *
 * Runs the engine in-process against a running fake GitHub + granary
 * (`mise run up`), prints progress and a summary, and exits 1 when any
 * invariant was violated (2 on errors).
 *
 * Flags: --preset <name>  --seed <n>  --personas <n>  --duration <seconds>
 *        --rate <per-minute>  --time-scale <x>  --json
 */
import { PRESET_NAMES, type CreateScenarioRequest, type PresetName, type ScenarioConfigPatch } from './schemas';
import { createLoadgen, LoadgenError } from './engine';
import { loadgenConfig } from './config';

function args(argv: string[]) {
	const out: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i++;
		} else out[key] = true;
	}
	return out;
}

const a = args(process.argv.slice(2));
if (a.help) {
	console.log('usage: bun loadgen/cli.ts [--preset smoke|steady|slop-storm|bot-flood|chaos|fuzz] [--seed N] [--personas N] [--duration S] [--rate N] [--time-scale X] [--json]');
	process.exit(0);
}
const preset = (typeof a.preset === 'string' ? a.preset : 'smoke') as PresetName;
if (!PRESET_NAMES.includes(preset)) {
	console.error(`unknown preset ${preset}; one of ${PRESET_NAMES.join(', ')}`);
	process.exit(2);
}
const patch: ScenarioConfigPatch = {};
if (typeof a.seed === 'string') patch.seed = Number(a.seed);
if (typeof a.personas === 'string') patch.personas = Number(a.personas);
if (typeof a.duration === 'string') patch.durationMs = Math.round(Number(a.duration) * 1000);
if (typeof a.rate === 'string') patch.arrivalRatePerMin = Number(a.rate);
if (typeof a['time-scale'] === 'string') patch.timeScale = Number(a['time-scale']);

const config = loadgenConfig();
const engine = createLoadgen({
	fakeGithubUrl: config.fakeGithubUrl,
	allowlisted: config.allowlisted,
	granaryLogin: config.granaryLogin,
	otlpEndpoint: config.otlpEndpoint,
	log: (m) => console.error(`[loadgen] ${m}`)
});

const request: CreateScenarioRequest = { preset, config: patch, start: true };
let exitCode = 0;
try {
	const created = await engine.createScenario(request);
	console.error(`scenario ${created.id} (${created.name}, seed ${created.seed}): ${created.personasPlanned} personas planned → repo ${created.repo.owner}/${created.repo.name}`);
	process.on('SIGINT', () => void engine.control(created.id, 'stop').catch(() => undefined));
	const detail = await engine.waitForEnd(created.id, (s) => {
		console.error(
			`  ${s.state.padEnd(9)} ${String(Math.round(s.elapsedMs / 1000)).padStart(4)}s  personas ${s.personasArrived}/${s.personasPlanned} (${s.personasActive} active)  issues ${s.issuesOpened}  violations ${s.violations}`
		);
	});
	if (a.json) {
		console.log(JSON.stringify(detail, null, 2));
	} else {
		const m = detail.metrics;
		const ms = (v: number | null) => (v === null ? '—' : `${(v / 1000).toFixed(2)} s`);
		console.log(`\n${detail.summary.name} (${detail.summary.id}) — ${detail.summary.state}`);
		console.log(`  issues opened        ${m.issuesOpened} (expected open ${m.expectedOpen}, expected closed ${m.expectedClosed})`);
		console.log(`  closed by granary    ${m.closedByGranary}   pending ${m.pendingClose}   overdue ${m.overdue}`);
		console.log(`  latency              p50 ${ms(m.latency.p50)}  p95 ${ms(m.latency.p95)}  p99 ${ms(m.latency.p99)}  max ${ms(m.latency.max)}`);
		console.log(`  webhooks             ${m.deliveries} delivered, ${m.deliveryFailures} failed, ${m.rawDeliveries} raw`);
		console.log(`  chaos                ${m.faultsInjected} fault(s), ${m.redeliveries} redelivery(ies)`);
		console.log(`  personas             ${m.personaActions} action(s), ${m.personaErrors} error(s)`);
		console.log('  invariants');
		for (const inv of detail.invariants) console.log(`    ${inv.status === 'ok' ? '✓' : inv.status === 'violated' ? '✗' : '…'} ${inv.title.padEnd(28)} ${inv.violations} violation(s), ${inv.checked} checked`);
		for (const v of detail.violations.slice(0, 20)) console.log(`    ! [${v.invariant}] ${v.message}${v.issue ? ` ${v.issue.htmlUrl}` : ''}`);
	}
	exitCode = detail.summary.violations > 0 ? 1 : 0;
} catch (e) {
	console.error(e instanceof LoadgenError ? `error ${e.status}: ${e.message}` : e);
	exitCode = 2;
}
engine.close();
process.exit(exitCode);
