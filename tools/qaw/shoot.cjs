#!/usr/bin/env node
/* SPORE v3 screenshot QA: serves dist/, screenshots routes at desktop+mobile,
   captures console errors + pageerrors + WebGL status. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/home/hatch/workspace/spore/tools/qaw/shots';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(DIST, p);
      if (p === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html'); // SPA fallback
      }
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
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const routes = ['/', '/agents', '/passport/demo-agent', '/developers', '/protocol', '/market', '/connect'];
  const viewports = [{ w: 1440, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }];
  const report = [];
  for (const vp of viewports) {
    for (const r of routes) {
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
      let webgl = 'unknown';
      try {
        await page.goto(base + r, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3500); // let lazy 3D chunk + reveal animations settle
        webgl = await page.evaluate(() => {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          return gl ? 'available' : 'unavailable';
        });
        const h1count = await page.evaluate(() => document.querySelectorAll('h1').length);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
        const shotName = `${vp.tag}-${r === '/' ? 'home' : r.replace(/\//g, '_').replace(/^_/, '')}.png`;
        await page.screenshot({ path: path.join(OUT, shotName), fullPage: false });
        report.push({ route: r, vp: vp.tag, h1: h1count, overflow, canvases: canvasCount, webgl, errors });
        console.log(`${vp.tag} ${r}: h1=${h1count} overflow=${overflow} canvas=${canvasCount} webgl=${webgl} errors=${errors.length}`);
        errors.forEach((e) => console.log('   ! ' + e));
      } catch (e) {
        report.push({ route: r, vp: vp.tag, failed: String(e).slice(0, 200) });
        console.log(`${vp.tag} ${r}: FAILED ${String(e).slice(0, 120)}`);
      }
      await page.close();
    }
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  srv.close();
  console.log('done -> ' + OUT);
})();
