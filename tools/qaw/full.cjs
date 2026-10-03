#!/usr/bin/env node
/* Full-page captures for design judgment. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/home/hatch/workspace/spore/tools/qaw/shots';
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
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
  });
  for (const [tag, w, h] of [['full-desktop', 1440, 900], ['full-mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, `${tag}-home-full.png`), fullPage: true });
    console.log(tag, 'errors:', errs.length, errs.join(' | '));
    await page.close();
  }
  await browser.close(); srv.close(); console.log('done');
})();
