#!/usr/bin/env node
/* Scroll-through QA: scrolls the page step by step (like a user), captures
   viewport shots of each section, and reports visibility of section content. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/home/hatch/workspace/spore/tools/qaw/shots/scroll';
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
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 150)); });
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  // Reveal internals
  const revealInfo = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.reveal')];
    const hidden = els.filter((el) => {
      const o = getComputedStyle(el).opacity;
      return parseFloat(o) < 0.05 && !el.classList.contains('is-visible');
    });
    return { total: els.length, hidden: hidden.length };
  });
  console.log('reveal elements:', JSON.stringify(revealInfo));
  // Scroll through in steps, shooting each viewport
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log('scrollHeight:', height);
  let i = 0;
  for (let y = 0; y < height; y += 800) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `step-${String(i).padStart(2, '0')}.png`) });
    i++;
  }
  // After full scroll, check hidden reveals again
  const revealAfter = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.reveal')];
    return els.filter((el) => parseFloat(getComputedStyle(el).opacity) < 0.05).length;
  });
  console.log('still-hidden reveals after scroll:', revealAfter);
  // Section text presence
  const probes = ['An agent starts as a spore', 'The history becomes the credit', 'One reputation', 'credit ledger', 'ILLUSTRATIVE'];
  for (const t of probes) {
    const found = await page.evaluate((tt) => document.body.innerText.includes(tt), t);
    console.log(`text "${t}": ${found ? 'PRESENT' : 'MISSING'}`);
  }
  console.log('errors:', errs.length, errs.join(' | '));
  await browser.close(); srv.close(); console.log('done');
})();
