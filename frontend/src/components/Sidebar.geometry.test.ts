/**
 * The sidebar's widget GEOMETRY, pinned at the stylesheet.
 *
 * Four breakpoints decide how big the identity host is — the 180px desktop
 * circle, the 128px mobile drawer (`@media (max-width: 1279px)`), the 64px
 * `.sidebar-compact` rail, and the 961-1279 band the legacy orb reads in
 * script. Only the stylesheet carries the first three, and vitest does not
 * apply stylesheets (`css` is off in `vitest.config.ts`), so these pins read
 * `Sidebar.css` from disk the way `acceptanceContracts.test.ts` does. A `?raw`
 * import of a stylesheet yields '' under vitest and would make every pin here
 * vacuous — hence readFileSync, and hence the non-empty check.
 *
 * These prove the RULES, not a rendered layout: a browser pass over the built
 * image stays the orchestrator's.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'Sidebar.css'), 'utf-8').replace(/\r\n/g, '\n');
const variables = readFileSync(join(HERE, '..', 'styles', 'variables.css'), 'utf-8');

/** A token's pixel value, read from the scale rather than assumed. */
function spacePx(token: string): number {
  const match = variables.match(new RegExp('--' + token + ':\\s*([0-9.]+)(rem|px);'));
  expect(match, `--${token} is missing from variables.css`).not.toBeNull();
  const value = Number(match![1]);
  return match![2] === 'rem' ? value * 16 : value;
}

/** A declaration's value inside a named rule, as a number of pixels. */
function px(body: string, property: string): number {
  const match = body.match(new RegExp(property + ':\\s*([0-9.]+)px'));
  expect(match, `${property} is missing`).not.toBeNull();
  return Number(match![1]);
}

function block(selector: string): string {
  const at = css.indexOf(selector + ' {');
  expect(at, `${selector} is missing from Sidebar.css`).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

describe('the circular mask never reaches a plugin widget', () => {
  it('reads a non-empty stylesheet, so no pin below is vacuous', () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it('gives the widget-carrying identity host a rectangular, unmasked, unanimated box', () => {
    const body = block('.avatar-container--widget');
    for (const declaration of ['width: 100%', 'height: auto', 'border-radius: 0', 'overflow: visible', 'transition: none']) {
      expect(body).toContain(declaration);
    }
  });

  it('lets no breakpoint re-impose the 180/128/64px circle on that host', () => {
    // Only the BASE circle rule may name `.avatar-container` unqualified. The
    // compact selector outranks the variant on specificity (0,3,0 against
    // 0,1,0, the variant being declared standalone so the ownership gate can
    // attribute it), so without the exemption the 64px box would win on the rail.
    expect(css.split('.avatar-container {').length - 1).toBe(1);
    expect(css).toContain('.sidebar.sidebar-compact .avatar-container:not(.avatar-container--widget) {');
    expect(css).toContain('  .avatar-container:not(.avatar-container--widget) {');
    expect(css).not.toContain('.sidebar.sidebar-compact .avatar-container {');
  });

  it('closes the identity block with a hairline at the widget host', () => {
    // Card 89c4eb9a scope A: the account row, the widget host and the hairline
    // under it are the identity block. Scoped to THIS rule — counting
    // `border-bottom` across the whole stylesheet would fail the next time any
    // unrelated surface grew one.
    const host = block('.sidebar-avatar-section');
    expect(host).toContain('border-bottom: 1px solid var(--border-subtle, var(--border-default))');
    expect(block('.sidebar-account')).not.toContain('border-bottom');
  });

  it('fits the account row inside the 96px compact rail', () => {
    // The rail is 96px wide with `--space-2` of padding each side, so a row has
    // 80px. A 36px monogram beside the 36px bell (the control kit's
    // `--control-compact` icon button), with the row's `--space-2` gaps, needs
    // 88px and NEITHER may shrink (both are `flex-shrink: 0`), so the row has
    // to stack here. This derives the 80px rather than repeating it, and fails
    // if the rail, the padding token or either fixed width moves.
    const rail = block('.sidebar.sidebar-compact');
    const content = px(rail, 'width') - 2 * spacePx('space-2');
    const monogram = px(block('.sidebar-account-avatar'), 'width');
    const control = spacePx('control-compact'); // the bell's width (.icon-btn)
    const gap = spacePx('space-2');
    // Both of the row's gaps count: the handle sits between the two fixed parts.
    expect(monogram + 2 * gap + control).toBeGreaterThan(content); // why it must stack
    const compact = block('.sidebar.sidebar-compact .sidebar-account');
    expect(compact).toContain('flex-direction: column');
    expect(Math.max(monogram, control)).toBeLessThanOrEqual(content);
    // and the handle, the only part that cannot be made to fit, is the only
    // part withheld — the bell itself stays on the rail.
    expect(block('.sidebar.sidebar-compact .sidebar-account-text')).toContain('display: none');
    expect(css).not.toMatch(/\.sidebar-compact[^{]*\.sidebar-account-bell[^{]*\{[^}]*display:\s*none/);
    expect(css).not.toContain('.sidebar.sidebar-compact .sidebar-preferences-link {\n  display: none');
  });

  it('gives the account row nothing but the avatar, the handle and the bell to lay out', () => {
    // Owner ruling E21 retired the `Signed in as` caption — the label that
    // truncated to `Signed …` at 1440px in the Batch 14 review — so its rule is
    // gone with it, and the bell keeps the row's trailing edge without the
    // `margin-left: auto` the departed Settings link supplied.
    expect(css).not.toContain('.sidebar-account-caption');
    expect(block('.sidebar-account')).toContain('justify-content: space-between');
    // The handle still ellipsises rather than wraps (the rendered width at
    // 1440px is measured by the lane's browser pass, not here).
    expect(block('.sidebar-account-handle')).toContain('text-overflow: ellipsis');
  });

  it('gives Settings the sign-out control\'s own grammar, so the foot reads as one pair', () => {
    // E21 moved Settings to sit immediately above Logout. The two are drawn
    // alike — every box and ink declaration the sign-out control carries, the
    // link carries with the same value — and hover the same way.
    const settings = block('.sidebar-preferences-link');
    const logout = block('.sidebar-logout-button');
    for (const property of ['width', 'display', 'align-items', 'justify-content', 'border-radius', 'border', 'background', 'color', 'padding']) {
      const value = logout.match(new RegExp('(?:^|\\n)\\s*' + property + ':\\s*([^;]+);'));
      expect(value, `${property} is missing from .sidebar-logout-button`).not.toBeNull();
      expect(settings, property).toContain(`${property}: ${value![1]};`);
    }
    const settingsHover = block('.sidebar-preferences-link:hover');
    const logoutHover = block('.sidebar-logout-button:hover');
    for (const line of logoutHover.split('\n').map((l) => l.trim()).filter(Boolean)) {
      expect(settingsHover).toContain(line);
    }
    // and a gap between the two, so they read as a pair rather than one box
    expect(settings).toContain('margin-bottom: var(--space-2)');
    // On the 96px rail it centres its glyph with the sign-out control's padding.
    expect(block('.sidebar.sidebar-compact .sidebar-preferences-link')).toContain('padding-left: 10px');
  });

  it('leaves no bare, unpressable label on the 96px rail', () => {
    // Review N1. The rail withholds every text label; the widget name was the
    // one that stayed, while the shared chevron rule had already removed its
    // affordance. The name is clipped now — never `display: none`, so the
    // button keeps its accessible name — and the chevron is restored for this
    // control alone, because a widget block has no icon of its own to press.
    const clipped = block('.sidebar.sidebar-compact .sidebar-preferences-text,\n.sidebar.sidebar-compact .sidebar-plugin-widget-name');
    expect(clipped).toContain('clip-path: inset(50%)');
    expect(clipped).not.toContain('display: none');
    expect(block('.sidebar.sidebar-compact .sidebar-plugin-widget-label .nav-group-chevron'))
      .toContain('display: inline-flex');
    // The control stays a control: a compact-sized target, not a 1px box.
    expect(block('.sidebar.sidebar-compact .sidebar-plugin-widget-label'))
      .toContain('min-height: var(--control-compact)');
  });

  it('clips the Settings word where it clips it, and never removes it', () => {
    // Live audit / review F4: the word is visible on the full rail. The one
    // rule that hides it — the 96px compact rail — uses clipping, so the
    // accessible name survives. Since E21 the drawer no longer clips it: the
    // link left the account row (whose 44px close-control gutter was the
    // reason) for the full-width foot above Logout.
    expect(block('.sidebar-preferences-text')).not.toContain('position: absolute');
    const compact = block('.sidebar.sidebar-compact .sidebar-preferences-text,\n.sidebar.sidebar-compact .sidebar-plugin-widget-name');
    expect(compact).toContain('clip-path: inset(50%)');
    expect(compact).not.toContain('display: none');
    const drawerStart = css.indexOf('@media (max-width: 1279px)');
    expect(drawerStart).toBeGreaterThan(-1);
    const drawer = css.slice(drawerStart, css.indexOf('\n}\n', drawerStart));
    expect(drawer).toContain('.sidebar-account {'); // the slice is the drawer block
    expect(drawer).not.toContain('.sidebar-preferences-text');
    expect(drawer).not.toContain('.sidebar-preferences-link');
  });

  it('keeps the account row a sticky, unfilled row on the rail background', () => {
    // The owner's 2026-09-18 report: a filled `--bg-surface` box on a rail whose
    // gradient starts at `--bg-app` reads as a notice, not as the account. The
    // row is flat now, and it keeps the sticky it shipped with.
    const row = block('.sidebar-account');
    for (const declaration of ['position: sticky', 'display: flex', 'background: var(--bg-app)']) {
      expect(row).toContain(declaration);
    }
    expect(row).not.toContain('var(--bg-surface)');
    expect(row).not.toContain('border-radius');
  });

  it('reserves the drawer close control its own space, so nothing overlaps it', () => {
    // Live audit 2026-09-18 P1 (`ux-mobile-drawer.png`): the menu control is
    // `position: fixed` and does not move when the drawer opens, so the close
    // glyph was painted ON TOP of the account label. This is the arithmetic of
    // that repair, not an echo of the declaration: the gutter the account row
    // reserves must cover everything the fixed control occupies INSIDE the
    // rail — its right edge minus the rail's own left padding.
    const hamburger = block('.sidebar-hamburger');
    const controlRight = px(hamburger, 'left') + px(hamburger, 'width');
    const railPadding = spacePx('space-4'); // the drawer's left padding
    const drawer = css.slice(css.indexOf('@media (max-width: 1279px)'));
    const row = drawer.slice(drawer.indexOf('  .sidebar-account {'));
    const gutterBody = row.slice(0, row.indexOf('}'));
    const calc = gutterBody.match(/padding-left:\s*calc\(([0-9.]+)px \+ var\(--space-2\)\)/);
    expect(calc, 'the drawer gutter is missing').not.toBeNull();
    const gutter = Number(calc![1]) + spacePx('space-2');
    expect(gutter).toBeGreaterThanOrEqual(controlRight - railPadding);
    // and the row is still a WCAG 2.5.5 sized target beside it
    expect(px(gutterBody, 'min-height')).toBeGreaterThanOrEqual(44);
  });

  describe('the closed-state mobile identity shares the menu control\'s row', () => {
    // Card 89c4eb9a, the P2 scope A deferred: below 1280px with the drawer
    // closed the handle rendered as a separate pill. It is now the second
    // cell of the row the control already draws. These derive every number
    // from the CONTROL's declarations, so moving the control reddens here.
    const control = () => block('.sidebar-hamburger');
    const chip = () => block('.sidebar-mobile-account');

    it('sits on the control\'s own top edge, at the control\'s own height and radius', () => {
      expect(chip()).toContain('position: fixed');
      expect(px(chip(), 'top')).toBe(px(control(), 'top'));
      expect(px(chip(), 'height')).toBe(px(control(), 'height'));
      expect(px(chip(), 'border-radius')).toBe(px(control(), 'border-radius'));
      expect(chip()).toContain('border: 1px solid var(--border-default)');
      expect(control()).toContain('border: 1px solid var(--border-default)');
      // and it is inset from the right by what the control is inset from the left
      expect(px(chip(), 'right')).toBe(px(control(), 'left'));
    });

    it('is clamped to the room the control leaves, so the two cannot meet at 320px', () => {
      // The budget is written term by term: viewport - control inset -
      // control width - row gap - chip inset - a margin the width of an inset.
      const budget = chip().match(/max-width:\s*min\(calc\(100vw - ([0-9.]+)px - ([0-9.]+)px - var\(--space-3\) - ([0-9.]+)px - ([0-9.]+)px\), ([0-9.]+)px\)/);
      expect(budget, 'the chip width budget is missing or not written out term by term').not.toBeNull();
      const [, controlInset, controlWidth, chipInset, margin, ceiling] = budget!.map(Number);
      expect(controlInset).toBe(px(control(), 'left'));
      expect(controlWidth).toBe(px(control(), 'width'));
      expect(chipInset).toBe(px(chip(), 'right'));
      expect(margin).toBeGreaterThan(0);
      // At the narrowest audited viewport the chip's LEFT edge (viewport -
      // inset - width) lands at least a row gap past the control's right edge.
      const narrowest = 320;
      const widest = Math.min(narrowest - controlInset - controlWidth - spacePx('space-3') - chipInset - margin, ceiling);
      const chipLeft = narrowest - px(chip(), 'right') - widest;
      const controlRight = px(control(), 'left') + px(control(), 'width');
      expect(chipLeft).toBeGreaterThanOrEqual(controlRight + spacePx('space-3'));
      // and it clips rather than grows or wraps
      expect(chip()).toContain('overflow: hidden');
      expect(chip()).toContain('white-space: nowrap');
      expect(block('.sidebar-mobile-account-handle')).toContain('text-overflow: ellipsis');
    });

    it('speaks the account row\'s grammar: the same monogram tokens, the same handle type', () => {
      const rowAvatar = block('.sidebar-account-avatar');
      const chipAvatar = block('.sidebar-mobile-account-avatar');
      for (const declaration of ['border-radius: var(--radius-full)', 'background: var(--bg-elevated)', 'font-weight: 700', 'border: 1px solid var(--border-default)']) {
        expect(rowAvatar).toContain(declaration);
        expect(chipAvatar).toContain(declaration);
      }
      // a circle, and one that fits the 44px cell with the control's 8px inset
      expect(px(chipAvatar, 'width')).toBe(px(chipAvatar, 'height'));
      expect(px(chipAvatar, 'height') + 2 * spacePx('space-2')).toBe(px(chip(), 'height'));
      const rowHandle = block('.sidebar-account-handle');
      const chipHandle = block('.sidebar-mobile-account-handle');
      for (const declaration of ['font-size: var(--text-sm)', 'font-weight: 600', 'color: var(--text-primary)']) {
        expect(rowHandle).toContain(declaration);
        expect(chipHandle).toContain(declaration);
      }
    });

    it('stays inside the band the plugin route reserves for the host\'s chrome', () => {
      // 1f8824c1: `PluginFrame.css` reserves `--plugin-chrome-safe-top` and
      // `PluginFrame.geometry.test.ts` measures it against BOTH pieces of
      // chrome. This is the local half: the chip is never lower than the
      // control, so the control's bottom edge remains the chrome's.
      expect(px(chip(), 'top') + px(chip(), 'height'))
        .toBeLessThanOrEqual(px(control(), 'top') + px(control(), 'height'));
    });
  });

  it('gives every secondary widget block a disclosure that hides nothing by default', () => {
    // Live audit 2026-09-18 P2. Collapsing must not unmount the frame: the
    // widget declares its own height over the bridge, and an unmount would
    // make the host re-handshake and re-measure on every expand.
    expect(block('.sidebar-plugin-widget-body--collapsed')).toContain('display: none');
    expect(block('.sidebar-plugin-widget-label')).toContain('cursor: pointer');
  });

  it('hides the labelled widget section on the 96px rail rather than overflowing it', () => {
    expect(block('.sidebar.sidebar-compact .sidebar-plugin-widgets')).toContain('display: none');
  });

  it('gives every widget block the full sidebar width and no clipping mask of its own', () => {
    for (const selector of ['.sidebar-plugin-widgets', '.sidebar-plugin-widget']) {
      const body = block(selector);
      expect(body).toContain('width: 100%');
      expect(body).not.toContain('border-radius: 50%');
      expect(body).not.toContain('overflow: hidden');
    }
  });
});

/**
 * Owner ruling E458: with `ui.sidebar_widget.frame: "section"` a plugin widget
 * is a sidebar SECTION, not a boxed block. The pins read the stylesheet; the
 * section heading is derived from the navigation group heading it must read as
 * (same inset, ink, tracking and radius), not copied from a literal here, so a
 * change to the navigation headings that leaves the widget behind goes red.
 */
describe('the section frame (E458)', () => {
  const declared = (body: string, property: string): string => {
    const match = body.match(new RegExp('(?:^|[\\s;])' + property + ':\\s*([^;]+);'));
    expect(match, `${property} is missing`).not.toBeNull();
    return match![1].trim();
  };

  it('drops the box: no border, radius, background or padding on the section widget', () => {
    const body = block('.sidebar-plugin-widget--section');
    expect(declared(body, 'border')).toMatch(/^(0|none)$/);
    expect(declared(body, 'border-radius')).toBe('0');
    expect(declared(body, 'background')).toMatch(/^(none|transparent)$/);
    expect(declared(body, 'padding')).toBe('0');
  });

  it('leaves the boxed block as it was, and the section rule after it so source order decides', () => {
    const base = block('.sidebar-plugin-widget');
    expect(declared(base, 'border')).toBe('1px solid var(--border-subtle, var(--border-default))');
    expect(declared(base, 'border-radius')).toBe('10px');
    expect(declared(base, 'background')).toBe('var(--overlay-weak)');
    expect(declared(base, 'padding')).toBe('0 6px 6px');
    expect(css.indexOf('.sidebar-plugin-widget--section {')).toBeGreaterThan(css.indexOf('.sidebar-plugin-widget {'));
    expect(css.indexOf('.sidebar-plugin-widget-label--section {')).toBeGreaterThan(css.indexOf('.sidebar-plugin-widget-label {'));
    expect(css.indexOf('.sidebar-plugin-widget-label--section:hover {')).toBeGreaterThan(css.indexOf('.sidebar-plugin-widget-label:hover {'));
  });

  it('does not override the sidebar gap or the full width the rows gain', () => {
    const body = block('.sidebar-plugin-widget--section');
    expect(body).not.toMatch(/(^|[\s;])(gap|width|margin|margin-left|margin-right):/);
  });

  it('draws the heading exactly as the navigation group headings are drawn', () => {
    const nav = block('.nav-group-header');
    const navLabel = block('.nav-group-label');
    const heading = block('.sidebar-plugin-widget-label--section');
    const widgetLabel = block('.sidebar-plugin-widget-label');
    expect(declared(heading, 'padding')).toBe(declared(nav, 'padding'));
    expect(declared(heading, 'border-radius')).toBe(declared(nav, 'border-radius'));
    expect(declared(heading, 'color')).toBe(declared(nav, 'color'));
    expect(declared(heading, 'letter-spacing')).toBe(declared(navLabel, 'letter-spacing'));
    // Size and case are inherited from the widget label, and are the nav label's.
    expect(declared(widgetLabel, 'font-size')).toBe(declared(navLabel, 'font-size'));
    expect(declared(widgetLabel, 'text-transform')).toBe(declared(navLabel, 'text-transform'));
    expect(declared(widgetLabel, 'gap')).toBe(declared(nav, 'gap'));
    expect(heading).not.toMatch(/(^|[\s;])(font-size|text-transform):/);
  });

  it('hovers like a navigation heading: the same wash, the ink unchanged', () => {
    const navHover = block('.nav-group-header:hover');
    const hover = block('.sidebar-plugin-widget-label--section:hover');
    expect(declared(hover, 'background')).toBe(declared(navHover, 'background'));
    expect(declared(hover, 'color')).toBe(declared(block('.nav-group-header'), 'color'));
  });

  it('is hidden with the rest of the widget section on the 96px rail, which no rule here re-shows', () => {
    expect(block('.sidebar.sidebar-compact .sidebar-plugin-widgets')).toContain('display: none !important');
    expect(css).not.toMatch(/sidebar-compact[^{]*sidebar-plugin-widget--section[^{]*\{[^}]*display:\s*(block|flex|inline)/);
  });
});

/**
 * Owner ruling E465: a section widget has no panel of its own. The container chain (the widget, the
 * body the heading controls, the label) paints nothing, and the body gives the rows the navigation's
 * own horizontal inset so the heading text, the row text and the menu share one left edge. The inset
 * is derived from the navigation group heading, never copied from a literal here. The frame's own
 * transparency and colour scheme are inline styles, pinned in PluginSidebarWidget.test.tsx and in the
 * real-browser drill.
 */
describe('the section frame paints no panel and aligns with the menu (E465)', () => {
  const declared = (body: string, property: string): string => {
    const match = body.match(new RegExp('(?:^|[\\s;])' + property + ':\\s*([^;]+);'));
    expect(match, `${property} is missing`).not.toBeNull();
    return match![1].trim();
  };
  const horizontal = (padding: string): string => {
    const parts = padding.split(/\s+/);
    return parts.length >= 2 ? parts[1] : parts[0];
  };

  it('paints nothing on the container chain: widget, body and heading are transparent', () => {
    expect(declared(block('.sidebar-plugin-widget--section'), 'background')).toMatch(/^(none|transparent)$/);
    expect(declared(block('.sidebar-plugin-widget-body--section'), 'background')).toBe('transparent');
  });

  it('gives the rows the navigation inset, so heading text, row text and the menu share one left edge', () => {
    const navInset = horizontal(declared(block('.nav-group-header'), 'padding'));
    const headingInset = horizontal(declared(block('.sidebar-plugin-widget-label--section'), 'padding'));
    const bodyPadding = declared(block('.sidebar-plugin-widget-body--section'), 'padding');
    expect(bodyPadding).toBe(`0 ${navInset}`);
    expect(headingInset).toBe(navInset);
  });

  it('leaves the boxed body alone and lets the section modifier win by source order', () => {
    const base = block('.sidebar-plugin-widget-body');
    expect(base).not.toMatch(/(^|[\s;])(background|padding)/);
    expect(css.indexOf('.sidebar-plugin-widget-body--section {')).toBeGreaterThan(css.indexOf('.sidebar-plugin-widget-body {'));
  });
});
