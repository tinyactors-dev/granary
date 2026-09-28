/**
 * granary brand assets (ADR 0270): a colored version of Lucide's `wheat` icon.
 *
 * One source of truth — the Lucide geometry below plus the palette — emits
 * every SVG variant and rasterises them with sharp (libvips + librsvg), so the
 * files in static/ can always be regenerated:
 *
 *   mise run brand:render
 *
 * Variants:
 *   - mark:  transparent background (README, light/dark surfaces that already
 *            have their own background)
 *   - tile:  the mark on a warm dark rounded square — the app logo, favicon.svg
 *            and the 128/512/1024 webp logos; reads on any tab bar or theme
 *   - small: the tile with thicker strokes and no kernel outlines, for 16–48 px
 *            (favicon.ico, favicon-32.png) where the outlines turn to mud
 *   - full:  full-bleed square, wheat inside the maskable safe zone
 *            (apple-touch-icon, manifest "maskable" icon)
 *   - github: flat avatar for the GitHub App logo (ADR 0271): one solid
 *            colour (GITHUB_BG) over the whole canvas — no gradient, no inner
 *            tile — and flat grain fills, the wheat sized to sit well inside the
 *            circle GitHub crops avatars to. Set the app's badge background to
 *            GITHUB_BG so any padding GitHub adds blends in. PNG, since GitHub
 *            rejects webp.
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const OUT = join(ROOT, 'static');
const BRAND = join(OUT, 'brand');

/** Lucide `wheat` (ISC licence, lucide.dev), 24×24, unchanged. */
const STALK = 'M2 22 16 8';
const KERNELS = [
	'M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z',
	'M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z',
	'M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z'
];
const TIP = 'M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z';
/** Added detail (not Lucide): the crease along each grain, only drawn at larger sizes. */
const CREASES = 'M5 12.6v4.8M9 8.6v4.8M13 4.6v4.8M6.6 19h4.8M10.6 15h4.8M14.6 11h4.8M20.6 3.4l-3.2 3.2';

/** Ripe wheat: pale-gold highlights, amber body, burnt-ochre outlines, straw stalk. */
const PALETTE = {
	grainLight: '#FBE08A',
	grainMid: '#F2B63F',
	grainDeep: '#D98A1E',
	outline: '#8A4F12',
	stalk: '#C89A45',
	stalkEdge: '#7A5418',
	tileTop: '#2E2419',
	tileBottom: '#15100B'
};

/** The GitHub App logo's background, also entered as the app's "badge background color". */
export const GITHUB_BG = '#1D1710';

type Variant = 'mark' | 'tile' | 'small' | 'full' | 'github';

function wheat(v: Variant): string {
	const small = v === 'small';
	const outlineW = small ? 0 : 0.75;
	const stalkW = small ? 2.6 : 2.2;
	// github: flat fills — a gradient inside a circular crop reads as a smudge at avatar sizes
	const fill = v === 'github' ? PALETTE.grainMid : 'url(#grain)';
	const kernel = (d: string) =>
		`<path d="${d}" fill="${fill}"${outlineW ? ` stroke="${PALETTE.outline}" stroke-width="${outlineW}" stroke-linejoin="round"` : ''}/>`;
	return [
		// straw stalk with a darker edge so it separates from light and dark backgrounds
		`<path d="${STALK}" stroke="${PALETTE.stalkEdge}" stroke-width="${stalkW + (small ? 0 : 0.9)}" stroke-linecap="round"/>`,
		`<path d="${STALK}" stroke="${PALETTE.stalk}" stroke-width="${stalkW}" stroke-linecap="round"/>`,
		...KERNELS.map(kernel),
		kernel(TIP),
		small ? '' : `<path d="${CREASES}" stroke="${PALETTE.outline}" stroke-width="0.45" stroke-linecap="round" opacity="0.55"/>`
	].join('');
}

function svg(v: Variant): string {
	const defs = `<defs>
<linearGradient id="grain" x1="22" y1="2" x2="3" y2="21" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="${PALETTE.grainLight}"/><stop offset="0.45" stop-color="${PALETTE.grainMid}"/><stop offset="1" stop-color="${PALETTE.grainDeep}"/>
</linearGradient>
<linearGradient id="tile" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="${PALETTE.tileTop}"/><stop offset="1" stop-color="${PALETTE.tileBottom}"/>
</linearGradient>
</defs>`;
	const fit = (scale: number) => `translate(12 12) scale(${scale}) translate(-12 -12)`;
	let body: string;
	if (v === 'github')
		// the wheat's diagonal extent is 10·√2·scale from the centre; 0.68 keeps its tips at ≈80 % of the
		// inscribed circle's radius (≈20 % margin inside the crop)
		body = `<rect width="24" height="24" fill="${GITHUB_BG}"/><g fill="none" transform="${fit(0.68)}">${wheat(v)}</g>`;
	else if (v === 'mark') body = `<g fill="none" transform="${fit(0.92)}">${wheat(v)}</g>`;
	else if (v === 'full') body = `<rect width="24" height="24" fill="url(#tile)"/><g fill="none" transform="${fit(0.6)}">${wheat('tile')}</g>`;
	else body = `<rect width="24" height="24" rx="5.2" fill="url(#tile)"/><g fill="none" transform="${fit(v === 'small' ? 0.8 : 0.74)}">${wheat(v)}</g>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${defs}${body}</svg>\n`;
}

async function png(v: Variant, size: number): Promise<Buffer> {
	return sharp(Buffer.from(svg(v)), { density: Math.max(72, (72 * size) / 24) })
		.resize(size, size)
		.png({ compressionLevel: 9 })
		.toBuffer();
}

async function webp(v: Variant, size: number): Promise<Buffer> {
	return sharp(await png(v, size)).webp({ lossless: true, effort: 6 }).toBuffer();
}

/** A .ico holding PNG images (supported by every current browser). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, i) => {
		const e = 6 + 16 * i;
		header.writeUInt8(size >= 256 ? 0 : size, e);
		header.writeUInt8(size >= 256 ? 0 : size, e + 1);
		header.writeUInt8(0, e + 2);
		header.writeUInt8(0, e + 3);
		header.writeUInt16LE(1, e + 4);
		header.writeUInt16LE(32, e + 6);
		header.writeUInt32LE(data.length, e + 8);
		header.writeUInt32LE(offset, e + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map((i) => i.data)]);
}

await mkdir(BRAND, { recursive: true });
const files: [string, string | Buffer][] = [
	['brand/granary.svg', svg('tile')],
	['brand/granary-mark.svg', svg('mark')],
	['brand/granary-small.svg', svg('small')],
	['brand/granary-maskable.svg', svg('full')],
	['favicon.svg', svg('tile')],
	['brand/granary-github.svg', svg('github')]
];
for (const size of [128, 512, 1024]) {
	files.push([`brand/granary-${size}.webp`, await webp('tile', size)]);
	files.push([`brand/granary-mark-${size}.webp`, await webp('mark', size)]);
}
files.push(['favicon.ico', ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png('small', size) }))))]);
files.push(['favicon-32.png', await png('small', 32)]);
files.push(['apple-touch-icon.png', await png('full', 180)]);
files.push(['brand/icon-192.png', await png('tile', 192)]);
files.push(['brand/icon-512.png', await png('tile', 512)]);
files.push(['brand/icon-maskable-512.png', await png('full', 512)]);
// GitHub App logo: PNG (GitHub rejects webp), opaque, < 1 MB
files.push(['brand/granary-github-512.png', await sharp(await png('github', 512)).flatten({ background: GITHUB_BG }).png({ compressionLevel: 9 }).toBuffer()]);
files.push(['brand/granary-github-1024.png', await sharp(await png('github', 1024)).flatten({ background: GITHUB_BG }).png({ compressionLevel: 9 }).toBuffer()]);
files.push([
	'manifest.webmanifest',
	JSON.stringify(
		{
			name: 'granary',
			short_name: 'granary',
			description: 'Auto-closes GitHub issues from users who are not on the allowlist.',
			start_url: '/',
			display: 'standalone',
			background_color: PALETTE.tileBottom,
			theme_color: PALETTE.tileBottom,
			icons: [
				{ src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
				{ src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
				{ src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
				{ src: '/brand/granary.svg', sizes: 'any', type: 'image/svg+xml' }
			]
		},
		null,
		'\t'
	) + '\n'
]);
for (const [name, data] of files) {
	await writeFile(join(OUT, name), data);
	console.log(`brand: ${name} (${typeof data === 'string' ? Buffer.byteLength(data) : data.length} bytes)`);
}
