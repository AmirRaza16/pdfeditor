import sharp from 'sharp';
import { readFileSync } from 'node:fs';

// Use a solid dark fill for raster icons (no media-query in PNG context)
const svg = readFileSync('public/favicon.svg', 'utf8').replace(/fill:\s*#000;?/i, 'fill:#171717;');
const buf = Buffer.from(svg);

const targets = [
  { file: 'public/favicon-96x96.png', size: 96, pad: 0 },
  { file: 'public/apple-touch-icon.png', size: 180, pad: 20, bg: { r: 255, g: 255, b: 255, alpha: 1 } },
  { file: 'public/web-app-manifest-192x192.png', size: 192, pad: 16, bg: { r: 255, g: 255, b: 255, alpha: 1 } },
  { file: 'public/web-app-manifest-512x512.png', size: 512, pad: 44, bg: { r: 255, g: 255, b: 255, alpha: 1 } },
];

for (const t of targets) {
  const inner = t.size - t.pad * 2;
  const rendered = await sharp(buf, { density: 384 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({
    create: { width: t.size, height: t.size, channels: 4, background: t.bg || { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: rendered, top: t.pad, left: t.pad }])
    .png()
    .toFile(t.file);
  console.log('Generated', t.file);
}
