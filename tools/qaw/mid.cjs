#!/usr/bin/env node
/* Mid-width QA: 768/1024/1280 — overflow, errors, h1, canvas. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const DIST = '/home/hatch/workspace/spore/apps/web/dist';
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
  const routes = ['/', '/agents', '/passport/x', '/developers', '/protocol', '/market', '/connect'];
  let bad = 0;
  for (const w of [768, 1024, 1280]) {
    for (const r of routes) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      const errs = [];
      page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
      await page.goto(base + r, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2500);
      const s = await page.evaluate(() => ({
        h1: document.querySelectorAll('h1').length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      const ok = s.h1 === 1 && !s.overflow && errs.length === 0;
      if (!ok) bad++;
      console.log(`${w} ${r}: h1=${s.h1} overflow=${s.overflow} errors=${errs.length}${ok ? '' : '  <-- CHECK'}${errs.length ? ' ' + errs.join('|') : ''}`);
      await page.close();
    }
  }
  // nav-link validity: click Network -> /#ledger scrolls to ledger
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/agents', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('nav a[href="/#ledger"]');
  await page.waitForTimeout(1500);
  const atLedger = await page.evaluate(() => {
    const el = document.getElementById('ledger');
    if (!el) return 'NO #ledger ELEMENT';
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 ? 'VISIBLE' : 'NOT IN VIEWPORT';
  });
  console.log('Network nav -> #ledger:', atLedger);
  if (atLedger !== 'VISIBLE') bad++;
  await browser.close(); srv.close();
  console.log(bad === 0 ? 'ALL MID-WIDTH CHECKS PASS' : `${bad} FAILURES`);
})();
