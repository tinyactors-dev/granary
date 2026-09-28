import sharp from 'sharp';
const root = process.argv[2]!, out = process.argv[3]!;
const tile = await sharp(`${root}/static/brand/granary-1024.webp`).resize(400, 400).png().toBuffer();
const mark = await sharp(`${root}/static/brand/granary-mark-1024.webp`).resize(400, 400).png().toBuffer();
const p32 = await sharp(`${root}/static/favicon-32.png`).png().toBuffer();
const p16 = await sharp(p32).resize(16, 16).png().toBuffer();
const up = async (b: Buffer, s: number) => sharp(b).resize(s, s, { kernel: 'nearest' }).png().toBuffer();
const bg = (w: number, h: number, c: string) => sharp({ create: { width: w, height: h, channels: 4, background: c } }).png().toBuffer();
await sharp(await bg(1700, 460, '#ffffff'))
	.composite([
		{ input: tile, left: 20, top: 20 },
		{ input: mark, left: 440, top: 20 },
		{ input: await bg(420, 420, '#18181b'), left: 860, top: 20 },
		{ input: mark, left: 870, top: 30 },
		{ input: await up(p16, 128), left: 1300, top: 20 },
		{ input: await up(p32, 128), left: 1450, top: 20 },
		{ input: p16, left: 1300, top: 180 },
		{ input: p32, left: 1340, top: 180 },
		{ input: await bg(120, 40, '#dee1e6'), left: 1300, top: 240 },
		{ input: p16, left: 1310, top: 252 },
		{ input: await bg(120, 40, '#202124'), left: 1440, top: 240 },
		{ input: p16, left: 1450, top: 252 }
	])
	.png()
	.toFile(out);
