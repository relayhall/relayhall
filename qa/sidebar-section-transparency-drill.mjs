#!/usr/bin/env node
/**
 * sidebar-section-transparency-drill.mjs: the real-browser proof that a sidebar
 * widget drawn with `ui.sidebar_widget.frame: "section"` has no panel of its own
 * (owner ruling E465).
 *
 * WHY A BROWSER. The panel was never a stylesheet rule. Chromium paints an
 * OPAQUE backdrop (the dark canvas, rgb(18, 18, 18)) behind an iframe whose
 * document declares a colour scheme the iframe ELEMENT does not share, so a
 * plugin page declaring `color-scheme: dark` inside a host element left at
 * `normal` sat on a darker panel than the sidebar. jsdom paints nothing, so only
 * a pixel read in a real browser can show it. The unit suites pin the rules
 * (Sidebar.geometry.test.ts) and the frame's inline style
 * (PluginSidebarWidget.test.tsx); this drill pins what the browser does with them.
 *
 * WHAT IT DOES. It serves the BUILT dashboard and a fake API entirely through
 * Playwright request interception (no server, no network, no database), with fake
 * widget documents that differ only in what the plugin page declares:
 *   plain        nothing declared                     (the control)
 *   dark         :root { color-scheme: dark }
 *   light-dark   :root { color-scheme: light dark }
 *   light        :root { color-scheme: light }
 *   meta-dark    <meta name="color-scheme" content="dark">
 *   body-bg      body { background: #111 }            (the plugin paints its own panel)
 * For each Theme (relay-dark, relay-light, high-contrast) at 1440x900 and 375x812
 * it reads a PIXEL INSIDE the frame area against the sidebar's own pixel at the
 * same y, and the x of the section heading text, of the rows' text and of the
 * navigation group icon, which must be one left edge.
 *
 * A document that paints its own body background (`body-bg`) is the plugin's
 * choice and cannot be undone by the host: it is reported, never failed.
 *
 * Usage (needs `playwright` with a Chromium, installed by the caller):
 *   node qa/sidebar-section-transparency-drill.mjs <frontend/dist> <output dir>
 * Red/green: run it against a build of a tree without the E465 change and the
 * `dark` and `meta-dark` variants fail; against this tree every check passes.
 * Exit status 0 = all checks passed, 1 = a check failed.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [dist, outDir] = process.argv.slice(2);
if (!dist || !outDir) {
  console.error('usage: node qa/sidebar-section-transparency-drill.mjs <frontend/dist> <output dir>');
  process.exit(64);
}
fs.mkdirSync(outDir, { recursive: true });
const ORIGIN = 'http://127.0.0.1:4799';
// The build's own base path, read from its index.html.
const BASE = (/(?:src|href)="(\/[^"]*?\/)assets\//.exec(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')) || [, '/dashboard/'])[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const HEAD = {
  plain: '',
  dark: '<style>:root{color-scheme:dark}</style>',
  'light-dark': '<style>:root{color-scheme:light dark}</style>',
  light: '<style>:root{color-scheme:light}</style>',
  'meta-dark': '<meta name="color-scheme" content="dark">',
  'body-bg': '<style>body{background:#111}</style>',
};
const PLUGIN_OWNED_PANEL = new Set(['body-bg']);

const widgetHtml = variant => `<!doctype html><html><head><meta charset="utf-8">${HEAD[variant]}<style>
html,body{margin:0;padding:0;font:13px sans-serif}
.row{box-sizing:border-box;height:40px;padding:10px 0;font-weight:600}
</style></head><body><div id="content">
<div class="row">Account one</div><div class="row">Account two</div><div class="row">Account three</div></div><script>
const report=()=>parent.postMessage({type:'iframeResize',height:Math.ceil(document.getElementById('content').getBoundingClientRect().height)},location.origin);
addEventListener('load',()=>{report();setTimeout(report,50);});
new ResizeObserver(report).observe(document.documentElement);
parent.postMessage({type:'relayhall-plugin-ready',version:1},location.origin);
</script></body></html>`;

const plugin = (variant, frame) => ({ name: 'usage-limits', version: '1.0.0', description: 'drill', healthy: true,
  schema_version: 'rh.plugin/1', capabilities: ['usage.quotas'], sidebar: [], routes: [], api_base: '/plugins/usage-limits',
  sidebar_widget: { path: '/widget/' + variant, height: 240, grow: true, ...(frame ? { frame } : {}) } });

async function serve(page, plugins) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      const widget = /^\/api\/plugins\/[a-z-]+\/widget\/([a-z-]+)$/.exec(p);
      if (widget && widget[1] in HEAD) return route.fulfill({ status: 200, contentType: 'text/html', body: widgetHtml(widget[1]) });
      if (p === '/api/plugins') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plugins }) });
      if (/^\/api\/plugin-host\/[a-z-]+\/bridge$/.test(p)) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ schemaVersion: 'rh.plugin.bridge/1', observedAt: new Date().toISOString() }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    }
    if (p.startsWith('/socket.io')) return route.abort();
    const file = p.startsWith(BASE) ? p.slice(BASE.length) : '';
    let full = path.join(dist, file);
    if (!file || !fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(dist, 'index.html');
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(full)] || 'application/octet-stream', body: fs.readFileSync(full) });
  });
}

const themes = ['relay-dark', 'relay-light', 'high-contrast'];
const viewports = [['desktop-1440', { width: 1440, height: 900 }], ['phone-375', { width: 375, height: 812 }]];
let failures = 0;
const check = (ok, what) => { if (!ok) failures++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };

const browser = await chromium.launch();
const decoder = await (await browser.newContext()).newPage();
async function pixel(buf, x, y) {
  return decoder.evaluate(async ([b64, px, py]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const g = canvas.getContext('2d'); g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(px, py, 1, 1).data);
  }, [buf.toString('base64'), x, y]);
}

function measure() {
  const frame = document.querySelector('.sidebar-plugin-widget iframe');
  const rect = frame.getBoundingClientRect();
  const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
  const doc = frame.contentDocument;
  const textLeft = selector => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const i = n.textContent.search(/\S/);
      const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1);
      return range.getBoundingClientRect().left;
    }
    return null;
  };
  let rowText = null;
  if (doc) {
    const node = doc.querySelector('.row').firstChild;
    const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 1);
    rowText = rect.left + range.getBoundingClientRect().left;
  }
  const icon = document.querySelector('.nav-group-header .nav-group-icon, .nav-group-header svg');
  return {
    frame: { left: rect.left, top: rect.top, right: rect.right, scheme: getComputedStyle(frame).colorScheme,
      background: getComputedStyle(frame).backgroundColor, inline: frame.getAttribute('style') },
    docScheme: doc ? getComputedStyle(doc.documentElement).colorScheme : null,
    sidebarLeft: sidebar.left,
    headingText: textLeft('.sidebar-plugin-widget-name'),
    rowText,
    menuIcon: icon ? icon.getBoundingClientRect().left : null,
  };
}

try {
  // The operating system's own preference decides what `light dark` resolves to, so the desktop pass runs under both.
  const passes = [];
  for (const theme of themes) for (const [vpLabel, viewport] of viewports) {
    for (const os of vpLabel.startsWith('desktop') ? ['light', 'dark'] : ['light']) passes.push([theme, vpLabel, viewport, os]);
  }
  for (const [theme, vpLabel, viewport, os] of passes) {
    for (const variant of Object.keys(HEAD)) for (const frame of ['section', undefined]) {
      if (frame === undefined && variant !== 'dark') continue; // the boxed control needs one document that declares a scheme
      const tag = `${theme}/${vpLabel}-os-${os}/${variant}/${frame ?? 'boxed'}`;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: os,
        isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
      await context.addInitScript(([origin, name]) => {
        localStorage.setItem('relayhall_session_active:' + origin, '1');
        localStorage.setItem('relayhall_prefs:' + origin, JSON.stringify({ theme: name }));
      }, [ORIGIN, theme]);
      const page = await context.newPage();
      await serve(page, [plugin(variant, frame)]);
      await page.goto(ORIGIN + BASE);
      await page.waitForSelector('.sidebar', { timeout: 20000 });
      if (viewport.width < 1280) await page.locator('.sidebar-hamburger').click();
      await page.waitForSelector('.sidebar-plugin-widget iframe', { timeout: 20000 });
      await page.waitForTimeout(1500);
      const m = await page.evaluate(measure);
      const png = await page.screenshot();
      fs.writeFileSync(path.join(outDir, tag.replace(/\//g, '_') + '.png'), png);
      const y = Math.round(m.frame.top + 20); // the middle of the first row
      const inside = await pixel(png, Math.round(m.frame.right - 12), y);
      const outside = await pixel(png, Math.round(m.sidebarLeft + 4), y);
      const same = inside.slice(0, 3).every((v, i) => Math.abs(v - outside[i]) <= 1);
      if (frame === 'section') {
        if (PLUGIN_OWNED_PANEL.has(variant)) {
          console.log(`info ${tag}: the plugin page paints its own panel (${inside.slice(0, 3)}), which the host cannot remove`);
        } else {
          check(same, `${tag}: a pixel in the frame (${inside.slice(0, 3)}) equals the sidebar's at the same y (${outside.slice(0, 3)})`);
          check(m.frame.scheme === m.docScheme || (m.docScheme === 'normal' && variant === 'meta-dark'),
            `${tag}: the frame element's colour scheme (${m.frame.scheme}) agrees with its document's (${m.docScheme})`);
        }
        if (variant === 'plain') {
          check(Math.abs(m.headingText - m.rowText) < 0.5 && Math.abs(m.headingText - m.menuIcon) < 0.5,
            `${tag}: heading text x ${m.headingText}, row text x ${m.rowText} and the navigation group icon x ${m.menuIcon} are one left edge`);
        }
      } else {
        check(!/color-scheme|background/.test(m.frame.inline || ''), `${tag}: a boxed widget's frame keeps its inline style (${m.frame.inline})`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`failures=${failures}`);
process.exit(failures ? 1 : 0);
