#!/usr/bin/env node
/* Debug: hero render state at 1024 and 1440 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/tmp/debug-hero';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(DIST, p);
      if (p === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  for (const w of [1440, 1024]) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(9000);
    const info = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const canvas = document.querySelector('canvas');
      const fallback = document.querySelector('[data-fallback]') || document.querySelector('svg[role="img"]');
      const reveals = [...document.querySelectorAll('[data-reveal]')].map((el) => ({
        op: getComputedStyle(el).opacity, vis: getComputedStyle(el).visibility,
      }));
      let glStatus = 'no-canvas';
      if (canvas) {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        glStatus = gl ? ('ctx-ok ' + canvas.width + 'x' + canvas.height) : 'ctx-null';
      }
      return {
        h1: !!h1, h1text: h1 ? h1.textContent.slice(0, 30) : null,
        h1style: h1 ? { op: getComputedStyle(h1).opacity, disp: getComputedStyle(h1).display } : null,
        canvas: !!canvas, glStatus,
        canvasRect: canvas ? canvas.getBoundingClientRect().toJSON() : null,
        fallback: !!fallback,
        revealCount: reveals.length, reveals: reveals.slice(0, 4),
        scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src.split('/').pop()),
      };
    });
    console.log(`=== ${w}px ===`);
    console.log(JSON.stringify(info, null, 1));
    console.log('errs:', errs.length ? errs : 'none');
    await page.screenshot({ path: path.join(OUT, `hero-${w}.png`) });
    await page.close();
  }
  await browser.close();
  srv.close();
  console.log('done');
})();
