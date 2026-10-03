#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/home/hatch/workspace/spore/tools/qaw/shots/chainfix';
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
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  // footer
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'footer.png') });
  const footerText = await page.evaluate(() => document.body.innerText.includes('Robinhood Chain (4663)') ? 'FOOTER OK' : 'FOOTER MISSING');
  console.log(footerText);
  // protocol deployment status
  await page.goto(base + '/protocol', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'protocol-status.png') });
  const protoText = await page.evaluate(() => document.body.innerText.includes('Robinhood Chain (4663)') ? 'PROTOCOL OK' : 'PROTOCOL MISSING');
  console.log(protoText);
  // passport chain line
  await page.goto(base + '/passport/demo', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  const ppText = await page.evaluate(() => {
    const t = document.body.innerText;
    return t.includes('Chain: Robinhood Chain') ? 'PASSPORT OK' : 'PASSPORT: ' + (t.match(/Chain:.*/) || ['?'])[0];
  });
  console.log(ppText);
  // no Base chain references anywhere visible
  const baseRef = await page.evaluate(() => /Base\b/.test(document.body.innerText) ? 'HAS BASE REF' : 'no Base refs');
  console.log('home:', baseRef);
  console.log('errors:', errs.length, errs.join('|'));
  await browser.close(); srv.close(); console.log('done');
})();
