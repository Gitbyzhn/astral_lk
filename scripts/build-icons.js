// PWA иконкаларын SVG-ден PNG-ге айналдырады (тек логотипті өзгерткенде керек).
// Қажет: Chromium + Playwright (`npm i -D playwright && npx playwright install chromium`).
//   npm run icons
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const TARGETS = [
  { src: 'logo.svg', out: 'icon-192.png', size: 192 },
  { src: 'logo.svg', out: 'icon-512.png', size: 512 },
  { src: 'maskable.svg', out: 'maskable-192.png', size: 192 },
  { src: 'maskable.svg', out: 'maskable-512.png', size: 512 },
  { src: 'maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

// require() NODE_PATH-ты да қарайды (глобал орнатылған Playwright үшін).
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();

for (const { src, out, size } of TARGETS) {
  const svg = await fs.readFile(path.join(ICONS, src), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: path.join(ICONS, out), omitBackground: true });
  console.log(`✓ ${out}`);
}

await browser.close();
