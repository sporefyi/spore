#!/usr/bin/env node
/* SPORE audit screenshot QA: serves dist/, captures all routes at 7 widths,
   console/page/request errors, h1/overflow/canvas/WebGL checks, full-page posters. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DIST = '/home/hatch/workspace/spore/apps/web/dist';
const OUT = '/home/hatch/workspace/spore/tools/qaw/shots-wave1';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(DIST, p);
      if (p === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
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

const VIEWPORTS = [
  { w: 1440, h: 900, tag: '1440x900' },
  { w: 1280, h: 800, tag: '1280x800' },
  { w: 1024, h: 768, tag: '1024x768' },
  { w: 768, h: 1024, tag: '768x1024' },
  { w: 430, h: 932, tag: '430x932' },
  { w: 390, h: 844, tag: '390x844' },
  { w: 375, h: 812, tag: '375x812' },
];
const ROUTES = ['/', '/agents', '/passport/demo-agent', '/developers', '/protocol', '/market', '/connect'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const report = [];
  for (const vp of VIEWPORTS) {
    for (const r of ROUTES) {
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 220)); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 220)));
      page.on('requestfailed', (req) => errors.push('reqfail: ' + req.url().slice(0, 120) + ' ' + (req.failure() || {}).errorText));
      page.on('response', (res) => { if (res.status() >= 400) errors.push('http' + res.status() + ': ' + res.url().slice(0, 120)); });
      try {
        await page.goto(base + r, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3500);
        const info = await page.evaluate(() => ({
          h1: document.querySelectorAll('h1').length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          canvases: document.querySelectorAll('canvas').length,
          title: document.title,
          links: document.querySelectorAll('a[href="#"], a:not([href])').length,
        }));
        const webgl = await page.evaluate(() => {
          const c = document.createElement('canvas');
          return (c.getContext('webgl2') || c.getContext('webgl')) ? 'available' : 'unavailable';
        });
        const name = `${vp.tag}-${r === '/' ? 'home' : r.replace(/\//g, '_').replace(/^_/, '')}.png`;
        await page.screenshot({ path: path.join(OUT, name), fullPage: false });
        report.push({ route: r, vp: vp.tag, ...info, webgl, errors });
        console.log(`${vp.tag} ${r}: h1=${info.h1} overflow=${info.overflow} canvas=${info.canvasCount ?? info.canvases} webgl=${webgl} deadlinks=${info.links} errors=${errors.length}`);
        errors.forEach((e) => console.log('   ! ' + e));
      } catch (e) {
        report.push({ route: r, vp: vp.tag, failed: String(e).slice(0, 200) });
        console.log(`${vp.tag} ${r}: FAILED ${String(e).slice(0, 120)}`);
      }
      await page.close();
    }
  }
  // full-page posters: desktop + mobile home, desktop protocol (score lab)
  for (const [vp, r, tag] of [[VIEWPORTS[0], '/', 'poster-desktop-home'], [VIEWPORTS[5], '/', 'poster-mobile-home'], [VIEWPORTS[0], '/protocol', 'poster-desktop-protocol']]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    try {
      await page.goto(base + r, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: path.join(OUT, tag + '.png'), fullPage: true });
      console.log(`poster ${tag} ok`);
    } catch (e) { console.log(`poster ${tag} FAILED ${String(e).slice(0, 100)}`); }
    await page.close();
  }
  // reduced-motion pass: home at 1440, ensure no errors and canvas present
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    const rm = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      mq: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }));
    await page.screenshot({ path: path.join(OUT, 'reduced-motion-home.png') });
    report.push({ route: '/', vp: 'reduced-motion', ...rm, errors });
    console.log(`reduced-motion: canvases=${rm.canvases} mq=${rm.mq} errors=${errors.length}`);
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  srv.close();
  console.log('done -> ' + OUT);
})();
