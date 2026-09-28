/**
 * The GitHub App logo step (ADR 0271): GitHub has no API for app logos, so
 * granary serves a flat PNG made for GitHub's circular crop, links to the
 * app's settings page (organization or personal) and shows a hint card until
 * an admin dismisses it. A new app shows the hint again.
 */
import { describe, expect, test } from 'bun:test';
import { runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink, remoteCommand } from './github-app';

const T = 60_000;
const h: () => Harness = useHarness({ github: 'manual' });

type Status = {
	mode: string;
	app: { slug: string; settingsUrl: string; logoHintDismissed: boolean } | null;
	pullRequests: { permissionsUrl: string } | null;
};

async function status(): Promise<Status> {
	const r = await runCli(h(), ['github', 'status', '--json']);
	expect(r.code).toBe(0);
	return JSON.parse(r.stdout) as Status;
}

/** The settings wizard's flow: begin (remote command) → the fake's manifest form (auto-confirm) → callback. */
async function createApp(cookie: string, input: { organization?: string; name: string }): Promise<{ slug: string; description: string }> {
	const form = await remoteCommand<{ postUrl: string; manifest: string; state: string }>(h(), cookie, '/settings/github', 'beginGitHubAppManifest', input);
	const post = new URL(form.postUrl);
	post.searchParams.set('auto', '1');
	post.searchParams.set('login', 'admin');
	const created = await fetch(post, { method: 'POST', body: new URLSearchParams({ manifest: form.manifest }), redirect: 'manual' });
	expect(created.status).toBe(302);
	const back = new URL(created.headers.get('location')!);
	const cb = await h().fetchApp(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } });
	expect(cb.headers.get('location') ?? '').toContain('created=1');
	const apps = (await h().fakeGithub.state()).apps ?? [];
	const app = apps[apps.length - 1] as { slug: string; description?: string };
	return { slug: app.slug, description: app.description ?? JSON.parse(form.manifest).description };
}

describe('GitHub App logo step', () => {
	let cookie = '';

	test(
		'granary serves the flat GitHub logo as a 512 × 512 PNG',
		async () => {
			const res = await h().fetchApp('/brand/granary-github-512.png');
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain('image/png');
			const png = new Uint8Array(await res.arrayBuffer());
			const view = new DataView(png.buffer);
			// IHDR: width and height at bytes 16..23
			expect([view.getUint32(16), view.getUint32(20)]).toEqual([512, 512]);
		},
		T
	);

	test(
		'an organization app links to its organization settings page and shows the logo hint until dismissed',
		async () => {
			const link = await runCli(h(), ['login-link', 'admin', '--json']);
			expect(link.code).toBe(0);
			cookie = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;

			const app = await createApp(cookie, { organization: 'acme', name: 'granary-logo-org' });
			expect(app.description).toBe("Closes issues and pull requests from people who aren't on the allowlist.");

			const s = await status();
			expect(s.mode).toBe('app');
			expect(s.app!.settingsUrl).toBe(`${h().fakeUrl}/organizations/acme/settings/apps/${app.slug}`);
			expect(s.app!.logoHintDismissed).toBe(false);

			await remoteCommand(h(), cookie, '/settings/github', 'dismissGitHubLogoHint', undefined);
			expect((await status()).app!.logoHintDismissed).toBe(true);
		},
		T
	);

	test(
		'a personal app links to /settings/apps/<slug>, and a new app shows the hint again',
		async () => {
			await remoteCommand(h(), cookie, '/settings/github', 'disconnectGitHub', undefined);
			expect((await status()).mode).toBe('none');

			const app = await createApp(cookie, { name: 'granary-logo-user' });
			const s = await status();
			expect(s.app!.settingsUrl).toBe(`${h().fakeUrl}/settings/apps/${app.slug}`);
			expect(s.app!.logoHintDismissed).toBe(false);
			if (s.pullRequests) expect(s.pullRequests.permissionsUrl).toBe(`${s.app!.settingsUrl}/permissions`);
		},
		T
	);
});
