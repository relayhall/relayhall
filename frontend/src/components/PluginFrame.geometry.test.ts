/**
 * THE HOST'S FLOATING MOBILE CHROME AND THE PLUGIN ROUTE FRAME, PINNED AGAINST
 * EACH OTHER.
 *
 * Below the hamburger breakpoint the shell floats `.sidebar-hamburger` and
 * `.sidebar-mobile-account` over whatever the route renders. Every core page
 * reserves its own space for them by hand; a plugin route renders an iframe
 * whose interior the host cannot reach into, so the host reserves the band
 * itself in `PluginFrame.css`.
 *
 * Two things these pins exist to stop, both found in review:
 *
 *  1. THE BAND ON THE WRONG SURFACE. `.plugin-frame-container` has more than
 *     one consumer — `PluginSettingsPage` embeds the same container halfway
 *     down the settings hub — so geometry declared on the bare class opened a
 *     52px hole in a page with no chrome anywhere near it. The band therefore
 *     hangs off a modifier, and the census below walks every `<PluginFrame`
 *     in the tree rather than trusting that there are only two.
 *  2. A NUMBER THIS FILE OWNS. The band is compared with the chrome geometry
 *     `Sidebar.css` actually declares, so growing the trigger without growing
 *     the band reddens here rather than in somebody's browser.
 *
 * These read source from disk the way `Sidebar.geometry.test.ts` does (vitest
 * applies no CSS, and a `?raw` import yields '' under it — hence readFileSync
 * and hence the non-empty checks). What a rule cannot decide — where the boxes
 * really land, at which viewport heights — is the browser pass's job.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const sidebarCss = readFileSync(join(HERE, 'Sidebar.css'), 'utf-8').replace(/\r\n/g, '\n');
const frameCss = readFileSync(join(HERE, 'PluginFrame.css'), 'utf-8').replace(/\r\n/g, '\n');
const frameTsx = readFileSync(join(HERE, 'PluginFrame.tsx'), 'utf-8');
const appCss = readFileSync(join(SRC, 'App.css'), 'utf-8');

const ROUTE_MODIFIER = 'plugin-frame-container--route';
const BAND_TOKEN = '--plugin-chrome-safe-top';
/**
 * Anchored on the band ARITHMETIC, not on the property it is assigned to, so a
 * mutation that keeps the band and spends it as padding still resolves here and
 * reddens the margin pin instead of vanishing from every pin at once.
 */
const FRAME_BAND_RULE = `calc(var(${BAND_TOKEN}) - var(--page-inset, 0px))`;

/** Blank out comments, keeping every byte offset, so braces in prose cannot lie. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length));
}

/**
 * The stack of block preludes open at a point in the stylesheet, outermost
 * first. Counted by BRACE DEPTH — "the nearest `@media` opener before this
 * line" is not the same question and answers wrongly for a rule that follows a
 * closed media block.
 */
function contextOf(css: string, needle: string, label: string): string[] {
  const at = css.indexOf(needle);
  expect(at, `${JSON.stringify(needle)} is missing from ${label}`).toBeGreaterThan(-1);
  const bare = stripComments(css);
  const stack: string[] = [];
  let preludeStart = 0;
  for (let i = 0; i < at; i += 1) {
    if (bare[i] === '{') {
      stack.push(bare.slice(preludeStart, i).trim());
      preludeStart = i + 1;
    } else if (bare[i] === '}') {
      stack.pop();
      preludeStart = i + 1;
    }
  }
  expect(stack.length, `${JSON.stringify(needle)} is not inside a rule in ${label}`).toBeGreaterThan(0);
  return stack;
}

/** The selector of the rule a declaration is in. */
function selectorOf(css: string, needle: string, label: string): string {
  const stack = contextOf(css, needle, label);
  return stack[stack.length - 1];
}

/** The media query a declaration is genuinely nested inside, normalised. */
function enclosingMedia(css: string, needle: string, label: string): string {
  const media = [...contextOf(css, needle, label)].reverse().find((p) => p.startsWith('@media'));
  expect(media, `no @media encloses ${JSON.stringify(needle)} in ${label}`).toBeDefined();
  return (media as string).replace(/^@media\s*/, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

/** The declarations between `selector {` and the next `}`. */
function block(css: string, selector: string, label: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is missing from ${label}`).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

/** The declarations of the rule that CONTAINS a given line. */
function blockContaining(css: string, needle: string, label: string): string {
  const at = css.indexOf(needle);
  expect(at, `${JSON.stringify(needle)} is missing from ${label}`).toBeGreaterThan(-1);
  const open = css.lastIndexOf('{', at);
  expect(open, `no rule encloses ${JSON.stringify(needle)} in ${label}`).toBeGreaterThan(-1);
  return css.slice(open + 1, css.indexOf('}', at));
}

/** A length declaration in px. Only the units this codebase uses are accepted. */
function lengthPx(body: string, property: string): number {
  const match = new RegExp(`(?:^|[;{\\s])${property}:\\s*([0-9.]+)(px|rem)\\s*;`).exec(body);
  expect(match, `${property} is not declared as a plain length`).not.toBeNull();
  const [, value, unit] = match as RegExpExecArray;
  return unit === 'rem' ? Number(value) * 16 : Number(value);
}

/** Every `<PluginFrame …/>` element in the tree, wherever it is mounted. */
function pluginFrameCallSites(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!path.endsWith('.tsx')) continue;
      const text = readFileSync(path, 'utf-8');
      let at = text.indexOf('<PluginFrame');
      while (at > -1) {
        const end = text.indexOf('/>', at);
        expect(end, `unterminated <PluginFrame in ${path}`).toBeGreaterThan(at);
        found.push({ file: path, text: text.slice(at, end + 2) });
        at = text.indexOf('<PluginFrame', at + 1);
      }
    }
  };
  walk(SRC);
  return found;
}

const HAMBURGER_REVEAL = '  .sidebar-hamburger {\n    display: inline-flex;';

describe('the host reserves space for its own floating mobile chrome on plugin routes', () => {
  it('reads four non-empty sources, so no pin below is vacuous', () => {
    for (const [name, text] of [['Sidebar.css', sidebarCss], ['PluginFrame.css', frameCss], ['PluginFrame.tsx', frameTsx], ['App.css', appCss]] as const) {
      expect(text.length, `${name} read empty`).toBeGreaterThan(0);
    }
  });

  it('reserves a non-zero band at all', () => {
    expect(lengthPx(block(frameCss, `.${ROUTE_MODIFIER}`, 'PluginFrame.css'), BAND_TOKEN)).toBeGreaterThan(0);
  });

  it('reserves at least as much as the chrome Sidebar.css declares, measured from Sidebar.css', () => {
    // BOTH pieces of floating chrome, not the trigger alone: card 89c4eb9a
    // gave the closed-state identity chip a declared height on the trigger's
    // row, so it is now measurable here and is measured. Each is
    // `position: fixed` from the viewport top, so its lowest edge is
    // top + height. Nothing here is a number this file chose.
    const chromeBottom = ['.sidebar-hamburger', '.sidebar-mobile-account'].map((selector) => {
      const rule = block(sidebarCss, selector, 'Sidebar.css');
      expect(rule, `${selector} is not fixed to the viewport`).toContain('position: fixed');
      return lengthPx(rule, 'top') + lengthPx(rule, 'height');
    });
    const band = lengthPx(block(frameCss, `.${ROUTE_MODIFIER}`, 'PluginFrame.css'), BAND_TOKEN);
    expect(band).toBeGreaterThan(Math.max(...chromeBottom));
  });

  it('reserves it at exactly the breakpoint that reveals the chrome', () => {
    expect(enclosingMedia(frameCss, FRAME_BAND_RULE, 'PluginFrame.css'))
      .toBe(enclosingMedia(sidebarCss, HAMBURGER_REVEAL, 'Sidebar.css'));
  });

  it('puts the band on the route modifier and never on the shared container class', () => {
    // MAJOR 1 from review: `.plugin-frame-container` is also rendered mid-page
    // by the plugin settings hub, where a band is a hole in the page.
    expect(selectorOf(frameCss, FRAME_BAND_RULE, 'PluginFrame.css')).toBe(`.${ROUTE_MODIFIER}`);
    for (const needle of ['margin-top:', 'margin-bottom:', 'height: calc(100svh']) {
      const at = frameCss.indexOf(needle);
      if (at === -1) continue;
      expect(selectorOf(frameCss, needle, 'PluginFrame.css')).toContain(ROUTE_MODIFIER);
    }
  });

  it('reserves it with margins, so the frame keeps the height it is given', () => {
    // border-box is global (index.css), so padding here would come straight out
    // of the plugin's own area.
    const mobile = blockContaining(frameCss, FRAME_BAND_RULE, 'PluginFrame.css');
    expect(mobile).toContain('margin-top:');
    expect(mobile).not.toContain('padding');
  });

  it('gives back the page inset it hangs below, so the route cannot scroll under the chrome', () => {
    expect(appCss).toContain('--page-inset');
    const mobile = blockContaining(frameCss, FRAME_BAND_RULE, 'PluginFrame.css');
    expect(mobile).toContain('margin-bottom: calc(-1 * var(--page-inset, 0px));');
  });

  it('sizes the route frame from the band instead of letting a floor fight it', () => {
    // MAJOR 2 from review: leaving the desktop height and the 400/600px floors
    // in place gave a window (100vh 624-663 at <=768px wide, 432-463 at
    // 769-1279) where the base fitted and the banded frame overflowed, scrolled,
    // and put the menu back over the iframe.
    const mobile = blockContaining(frameCss, FRAME_BAND_RULE, 'PluginFrame.css');
    expect(mobile).toContain(`height: calc(100svh - var(${BAND_TOKEN}));`);
    expect(mobile).toContain('min-height: 0;');
    const iframeRule = `.${ROUTE_MODIFIER} .plugin-iframe {`;
    expect(frameCss).toContain(iframeRule);
    expect(block(frameCss, `.${ROUTE_MODIFIER} .plugin-iframe`, 'PluginFrame.css')).toContain('min-height: 0;');
    expect(enclosingMedia(frameCss, iframeRule, 'PluginFrame.css'))
      .toBe(enclosingMedia(sidebarCss, HAMBURGER_REVEAL, 'Sidebar.css'));
  });

  it('emits the route modifier only for the route surface', () => {
    expect(frameTsx).toContain("surface === 'route'");
    expect(frameTsx.split(ROUTE_MODIFIER).length - 1).toBe(1);
    const at = frameTsx.indexOf(ROUTE_MODIFIER);
    const guard = frameTsx.lastIndexOf("surface === 'route'", at);
    expect(guard, 'the modifier is emitted without a surface guard').toBeGreaterThan(-1);
    expect(at - guard).toBeLessThan(120);
  });

  it('accounts for every place the tree mounts a plugin frame, not only the two known ones', () => {
    const sites = pluginFrameCallSites();
    expect(sites.length, 'no <PluginFrame> found — the census is looking in the wrong place').toBeGreaterThan(1);
    for (const site of sites) {
      expect(site.text, `${basename(site.file)} mounts a plugin frame without naming its surface`)
        .toMatch(/surface="(route|embedded)"/);
    }
    const bySurface = (want: string) => sites.filter(s => s.text.includes(`surface="${want}"`)).map(s => basename(s.file));
    expect(bySurface('route')).toContain('App.tsx');
    // The surface that must NOT get the band, named so a future edit that flips
    // it has to argue with this line.
    expect(bySurface('embedded')).toContain('PluginSettingsPage.tsx');
    expect(bySurface('route').length + bySurface('embedded').length).toBe(sites.length);
  });
});
