/**
 * Rasteriza assets/img/elorai-logo.svg a los PNG que usa el sitio
 * (favicons y apple-touch-icon).
 *
 *   npm i -D playwright && node tools/render_logo.mjs
 *
 * El SVG es la fuente de verdad: si cambia la paleta, se toca solo ese archivo
 * y se vuelve a ejecutar este script.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/img/elorai-logo.svg'), 'utf8');

const targets = [
  { file: 'favicon-32.png', size: 32, bg: null },
  { file: 'favicon-192.png', size: 192, bg: null },
  { file: 'favicon-512.png', size: 512, bg: null },
  // iOS no respeta la transparencia: el icono lleva fondo lavanda y margen.
  { file: 'apple-touch-icon.png', size: 180, bg: '#eef2ff', pad: 0.12 },
];

const browser = await chromium.launch();

for (const { file, size, bg, pad = 0 } of targets) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const inset = Math.round(size * pad);
  await page.setContent(
    `<style>
       html,body{margin:0;padding:0;width:${size}px;height:${size}px;
         background:${bg || 'transparent'};display:grid;place-items:center}
       svg{width:${size - inset * 2}px;height:${size - inset * 2}px;display:block}
     </style>${svg}`,
    { waitUntil: 'load' }
  );
  const buffer = await page.screenshot({ omitBackground: !bg });
  writeFileSync(join(root, 'assets/img', file), buffer);
  await page.close();
  console.log('->', file, `${size}x${size}`);
}

await browser.close();
