// Бренд суреттерін логотиптен (brand/astral-labyrinth.jpg) жасайды — тек логотипті ауыстырғанда керек.
// Қажет: Chromium + Playwright (`npm i -D playwright && npx playwright install chromium`).
//   npm run icons
//
//   public/brand/logo.webp     — толық логотип (кіру беті, клиенттің басты беті)
//   public/brand/mark.webp     — эмблема (үшбұрыш пен есік): жоғарғы жолақтағы кішкентай белгі
//   public/icons/favicon.png   — браузер қойындысы
//   public/icons/icon-*.png, apple-touch-icon.png — телефонның басты экраны (толық логотип)
//   public/icons/maskable-*.png — Android-тың дөңгелек/пішінді иконкасы: логотип қауіпсіз аймақта
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'brand', 'astral-labyrinth.jpg');

// Эмблема қиындысы түпнұсқадағы (1254×1254) координаттармен: [x, y, өлшемі]
const MARK = [397, 118, 460];

const TARGETS = [
  { out: 'public/brand/logo.webp', size: 640, kind: 'full', type: 'image/webp', quality: 0.82 },
  { out: 'public/brand/mark.webp', size: 160, kind: 'mark', type: 'image/webp', quality: 0.86 },
  { out: 'public/icons/favicon.png', size: 64, kind: 'mark', type: 'image/png' },
  { out: 'public/icons/icon-192.png', size: 192, kind: 'full', type: 'image/png' },
  { out: 'public/icons/icon-512.png', size: 512, kind: 'full', type: 'image/png' },
  { out: 'public/icons/apple-touch-icon.png', size: 180, kind: 'full', type: 'image/png' },
  { out: 'public/icons/maskable-192.png', size: 192, kind: 'maskable', type: 'image/png' },
  { out: 'public/icons/maskable-512.png', size: 512, kind: 'maskable', type: 'image/png' },
  // Android хабарламасының кішкентай белгісі: тек ақ сұлба (мөлдір фонда) — үшбұрыш пен есік
  { out: 'public/icons/badge-96.png', size: 96, kind: 'badge', type: 'image/png' },
];

const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <path d="M48 14 L86 82 H10 Z" fill="none" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>
  <path d="M38 82 V62 a10 10 0 0 1 20 0 V82" fill="none" stroke="#fff" stroke-width="7"/>
  <circle cx="48" cy="6" r="5" fill="#fff"/>
</svg>`;

// require() NODE_PATH-ты да қарайды (глобал орнатылған Playwright үшін).
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const source = `data:image/jpeg;base64,${(await fs.readFile(SOURCE)).toString('base64')}`;

for (const target of TARGETS) {
  const dataUrl = await page.evaluate(
    async ({ source, target, mark }) => {
      const img = new Image();
      img.src = source;
      await img.decode();
      const { size } = target;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const full = img.naturalWidth;

      // Үлкен суретті бірден кішірейтсе бұлыңғыр/тісті болады — екі есе қадаммен кішірейтеміз
      const scaled = (sx, sy, sw, out) => {
        let src = document.createElement('canvas');
        src.width = src.height = sw;
        src.getContext('2d').drawImage(img, sx, sy, sw, sw, 0, 0, sw, sw);
        while (src.width / 2 >= out) {
          const next = document.createElement('canvas');
          next.width = next.height = Math.round(src.width / 2);
          const c = next.getContext('2d');
          c.imageSmoothingQuality = 'high';
          c.drawImage(src, 0, 0, next.width, next.height);
          src = next;
        }
        return src;
      };

      if (target.kind === 'badge') {
        const badge = new Image();
        badge.src = `data:image/svg+xml,${encodeURIComponent(target.svg)}`;
        await badge.decode();
        ctx.drawImage(badge, 0, 0, size, size);
      } else if (target.kind === 'mark') {
        ctx.drawImage(scaled(mark[0], mark[1], mark[2], size), 0, 0, size, size);
      } else if (target.kind === 'full') {
        ctx.drawImage(scaled(0, 0, full, size), 0, 0, size, size);
      } else {
        // maskable: фон — логотиптің бұлдыр, үлкейтілген көшірмесі; логотип 84% өлшемде, жиегі біртіндеп жоғалады
        const inner = Math.round(size * 0.84);
        const offset = Math.round((size - inner) / 2);
        ctx.filter = `blur(${Math.round(size / 24)}px) brightness(0.7)`;
        ctx.drawImage(img, -size * 0.1, -size * 0.1, size * 1.2, size * 1.2);
        ctx.filter = 'none';
        const layer = document.createElement('canvas');
        layer.width = layer.height = inner;
        const lc = layer.getContext('2d');
        lc.imageSmoothingQuality = 'high';
        lc.drawImage(scaled(0, 0, full, inner), 0, 0, inner, inner);
        lc.globalCompositeOperation = 'destination-in';
        const fade = Math.round(inner * 0.07);
        for (const [x0, y0, x1, y1] of [
          [0, 0, fade, 0],
          [inner, 0, inner - fade, 0],
          [0, 0, 0, fade],
          [0, inner, 0, inner - fade],
        ]) {
          const g = lc.createLinearGradient(x0, y0, x1, y1);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,1)');
          lc.fillStyle = g;
          lc.fillRect(0, 0, inner, inner);
        }
        ctx.drawImage(layer, offset, offset);
      }
      return canvas.toDataURL(target.type, target.quality);
    },
    { source, target: { ...target, svg: BADGE_SVG }, mark: MARK },
  );
  const out = path.join(ROOT, target.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`✓ ${target.out} (${target.size}px)`);
}

await browser.close();

// PNG-лерді 256 түске ықшамдау (көзге айырмашылығы жоқ, файл 2–3 есе кіші). Python + Pillow болса ғана.
const pngs = TARGETS.filter((t) => t.type === 'image/png' && t.kind !== 'badge').map((t) => path.join(ROOT, t.out));
const PY = `
import sys
from PIL import Image
for p in sys.argv[1:]:
    Image.open(p).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True)
`;
try {
  execFileSync('python3', ['-c', PY, ...pngs], { stdio: 'inherit' });
  console.log('✓ PNG иконкалар ықшамдалды (256 түс)');
} catch {
  console.log('• Python/Pillow жоқ — PNG иконкалар ықшамдалмады (жұмысқа әсері жоқ)');
}
