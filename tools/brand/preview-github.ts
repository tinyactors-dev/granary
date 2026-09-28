/**
 * Preview of the GitHub App logo as GitHub shows it: cropped to a circle on
 * GitHub's light (#ffffff) and dark (#0d1117) UI, at avatar sizes from the app
 * page (~200 px) down to a comment byline (20 px). ADR 0271.
 *
 *   mise run brand:preview-github -- <out.png>
 */
import sharp from 'sharp';

const root = process.argv[2]!;
const out = process.argv[3]!;
const src = `${root}/static/brand/granary-github-1024.png`;

const circle = async (size: number) => {
	const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
	const img = await sharp(src).resize(size, size).png().toBuffer();
	return sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
};

const sizes = [200, 96, 48, 32, 20];
const row = async (bg: string) => {
	const layers: sharp.OverlayOptions[] = [];
	let x = 20;
	for (const s of sizes) {
		layers.push({ input: await circle(s), left: x, top: 20 + (200 - s) / 2 });
		x += s + 30;
	}
	return { width: x, png: await sharp({ create: { width: x, height: 240, channels: 4, background: bg } }).composite(layers).png().toBuffer() };
};

const light = await row('#ffffff');
const dark = await row('#0d1117');
await sharp({ create: { width: light.width, height: 480, channels: 4, background: '#ffffff' } })
	.composite([
		{ input: light.png, left: 0, top: 0 },
		{ input: dark.png, left: 0, top: 240 }
	])
	.png()
	.toFile(out);
console.log(`brand: GitHub preview -> ${out}`);
