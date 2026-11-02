// Claude сілтемесі (artifact) нұсқасын бір HTML файлға жинау:  npm run build:artifact
// Ортақ беттер (public/assets/js/...) өзгеріссіз алынады, тек деректер қабаты ауыстырылады:
//   core/api.js → artifact/api.js (Claude деректер базасы), core/live.js, core/router.js (#hash),
//   core/pwa.js, core/env.js, core/logo.js (логотиптер бетке data: URI ретінде салынады).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { renderDocument } from '../artifact/template.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'public', 'assets', 'js', 'core');
const SWAPPED = new Set(['api.js', 'live.js', 'router.js', 'pwa.js', 'env.js', 'logo.js']);
const QR_LIBRARY = path.join(ROOT, 'public', 'vendor', 'qrcode.mjs');

const artifactSwap = {
  name: 'astral-artifact-swap',
  setup(build) {
    build.onResolve({ filter: /^\/vendor\/qrcode\.mjs$/ }, () => ({ path: QR_LIBRARY }));
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const target = path.resolve(args.resolveDir, args.path);
      if (path.dirname(target) === CORE && SWAPPED.has(path.basename(target))) {
        return { path: path.join(ROOT, 'artifact', path.basename(target)) };
      }
      return undefined;
    });
  },
};

const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'artifact', 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  banner: { js: '/* Astral — кезек жүйесі. QR: qrcode-generator (c) Kazuhiko Arase, MIT License */' },
  loader: { '.webp': 'dataurl' },
  plugins: [artifactSwap],
});
const js = bundle.outputFiles[0].text;

const cssSource = await fs.readFile(path.join(ROOT, 'public', 'assets', 'css', 'app.css'), 'utf8');
const css = (await esbuild.transform(cssSource, { loader: 'css', minify: true, charset: 'utf8' })).code;

if (/<\/script/i.test(js)) throw new Error('JS ішінде </script кездесті — бетті бұзады');
if (/<\/style/i.test(css)) throw new Error('CSS ішінде </style кездесті');

// Бастапқы мысал билет түрлері: Claude деректер базасына да дәл осылар жазылады (artifact/seed.json),
// сондықтан клиент беті алғашқы жариялаудан-ақ билет атауларын көрсетеді.
const seed = JSON.parse(await fs.readFile(path.join(ROOT, 'artifact', 'seed.json'), 'utf8'));
const types = Object.fromEntries(Object.entries(seed['meta/catalog'].types).map(([id, t]) => [id, [t.name, t.color]]));
const state = { v: 1, day: null, u: 0, open: [], serving: [], cancelled: [], types, business: seed['meta/settings'].businessName, tz: seed['meta/settings'].timeZone };
const html = renderDocument({ css, js, state, title: `${state.business} кезегі` });

const out = path.join(ROOT, 'dist', 'astral-artifact.html');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, html);
console.log(`✓ ${path.relative(ROOT, out)} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
