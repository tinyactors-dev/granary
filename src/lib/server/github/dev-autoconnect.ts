/**
 * Dev/tests: connect to the fake GitHub as a GitHub App automatically
 * (ADR 0230). granary only talks to GitHub as an App; in production the app
 * is created by an admin in /settings/github. With
 * `GRANARY_DEV_GITHUB_AUTOCONNECT=1` and `GRANARY_GITHUB_WEB_URL` pointing at
 * the fake, this runs the same manifest flow server-side (the fake
 * auto-confirms), then tells the fake to install the app on every account
 * with repo activity. It is inert against anything that is not the fake:
 * it only acts when `<web>/__control/state` answers, which github.com does not.
 *
 * It re-checks periodically, because the fake keeps its state in memory: after
 * a fake restart the app granary knows is gone, so granary disconnects and
 * connects again.
 */
import type { Config } from '../../schemas/config';
import { log } from '../log';
import type { GitHubConnection } from './connection';

const ACTOR = 'dev-autoconnect';
/** App name → slug `granary` → bot login `granary[bot]` (what loadgen expects). */
const APP_NAME = 'granary';
const INTERVAL_MS = 15_000;

interface FakeStateApps {
	apps?: { id: number; autoInstall?: boolean }[];
}

async function fakeApps(web: string): Promise<FakeStateApps['apps'] | null> {
	try {
		const res = await fetch(`${web}/__control/state`, { signal: AbortSignal.timeout(3_000) });
		if (!res.ok) return null;
		return ((await res.json()) as FakeStateApps).apps ?? [];
	} catch {
		return null;
	}
}

async function connect(github: GitHubConnection, web: string): Promise<void> {
	const form = github.beginManifest({ name: APP_NAME }, ACTOR);
	const url = new URL(form.postUrl);
	url.searchParams.set('auto', '1');
	url.searchParams.set('login', 'admin');
	const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ manifest: form.manifest }), redirect: 'manual' });
	const location = res.headers.get('location');
	const code = location ? new URL(location).searchParams.get('code') : null;
	if (res.status !== 302 || !code) throw new Error(`fake GitHub did not create the app (HTTP ${res.status})`);
	const done = await github.completeManifest(code, form.state, ACTOR);
	log.info(`github: dev autoconnect created GitHub App ${done.slug} (#${done.appId}) on ${web}`);
}

async function ensure(github: GitHubConnection, web: string): Promise<void> {
	const apps = await fakeApps(web);
	if (!apps) return; // not the fake (or not up yet)
	const known = github.store.getApp();
	if (github.mode() === 'app' && known && !apps.some((a) => a.id === known.app_id)) {
		log.info(`github: the fake GitHub no longer knows app #${known.app_id} (restarted?); reconnecting`);
		github.disconnect(ACTOR);
	}
	if (github.mode() !== 'app') await connect(github, web);
	const app = github.store.getApp();
	if (!app) return;
	const entry = (await fakeApps(web))?.find((a) => a.id === app.app_id);
	if (entry?.autoInstall) return;
	const res = await fetch(`${web}/__control/apps/${app.app_id}/auto-install`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ enabled: true })
	});
	if (!res.ok) throw new Error(`auto-install: HTTP ${res.status}`);
}

/** Start the loop; returns a stop function. Runs once immediately. */
export function startDevGithubAutoconnect(github: GitHubConnection, config: Config): () => void {
	const web = config.githubWebUrl;
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			await ensure(github, web);
		} catch (e) {
			log.warn(`github: dev autoconnect to ${web} failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			running = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), INTERVAL_MS);
	(timer as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}
