/**
 * The Tasks page header controls on a phone (E464, E466).
 *
 * The view switch, Search and More stay on ONE line that scrolls sideways
 * inside itself at 768 px and below; New task, the primary action, sits beside
 * that scrolling line and never inside it, so it can never be cut by the row's
 * edge fade (E466). At 769 px and wider the header is the rule it always was:
 * the scrolling line is a `display: contents` wrapper, so its controls are the
 * header actions' own flex items again. The More menu opens inside that
 * scrolling row, so it is lifted out of the row's clip (a fixed box that keeps
 * its place in the flow). The real-browser proof is the census
 * (scripts/mobile-overflow-census.mjs); this pins the stylesheet and the wiring.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'TasksPage.css'), 'utf-8').replace(/\r\n/g, '\n');
const tsx = readFileSync(join(HERE, 'TasksPage.tsx'), 'utf-8').replace(/\r\n/g, '\n');

const MEDIA = '@media (max-width: 768px) {';
const mediaStart = css.indexOf(`\n${MEDIA}\n  .tasks-page-header-actions {`);
const mediaEnd = mediaStart < 0 ? -1 : css.indexOf('\n}\n', mediaStart + 1);
const media = mediaStart < 0 ? '' : css.slice(mediaStart, mediaEnd);
const desktop = mediaStart < 0 ? css : css.slice(0, mediaStart) + css.slice(mediaEnd + 2);
const phoneRule = (selector: string) => {
  const start = media.indexOf(`\n  ${selector} {`);
  expect(start, `${selector} is missing from the phone block`).toBeGreaterThanOrEqual(0);
  return media.slice(start, media.indexOf('\n  }', start));
};

describe('the header actions: one scrolling line at 768 px and below', () => {
  test('the phone block exists exactly once', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    expect(css.split(MEDIA).length - 1).toBe(1);
  });

  test('the desktop header rules are what they were before E464', () => {
    const start = desktop.indexOf('\n.tasks-page-header-actions {');
    expect(desktop.slice(start + 1, desktop.indexOf('\n}', start) + 3)).toBe(`.tasks-page-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}
`);
    expect(desktop).not.toMatch(/\.tasks-page-header-actions[^{]*\{[^}]*overflow/);
    expect(desktop).not.toMatch(/\.tasks-page-header-actions[^{]*::-webkit-scrollbar/);
    expect(desktop).not.toMatch(/\.tasks-overflow-menu[^{]*\{[^}]*position:\s*fixed/);
  });

  test('E466: on a wide screen the scrolling line has no box of its own, so the header is pixel for pixel what it was', () => {
    const start = desktop.indexOf('\n.tasks-page-header-scroll {');
    expect(start, '.tasks-page-header-scroll is missing').toBeGreaterThanOrEqual(0);
    expect(desktop.slice(start + 1, desktop.indexOf('\n}', start) + 3)).toBe(`.tasks-page-header-scroll {
  display: contents;
}
`);
    expect(desktop).not.toMatch(/\.tasks-page-header-scroll[^{]*\{[^}]*overflow/);
  });

  test('on a phone the header actions never wrap and never grow past their column', () => {
    const body = phoneRule('.tasks-page-header-actions');
    expect(body).toMatch(/flex-wrap:\s*nowrap/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).not.toMatch(/overflow/);
    expect(phoneRule('.tasks-page-header-actions > *')).toMatch(/flex:\s*0 0 auto/);
  });

  test('on a phone the controls beside New task are one line that scrolls inside itself', () => {
    const body = phoneRule('.tasks-page-header-scroll');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/gap:\s*inherit/);
    expect(body).toMatch(/flex:\s*0 1 auto/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/overflow-y:\s*hidden/);
    expect(body).toMatch(/scrollbar-width:\s*none/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgba?\(/);
    expect(phoneRule('.tasks-page-header-scroll::-webkit-scrollbar')).toMatch(/display:\s*none/);
    expect(phoneRule('.tasks-page-header-scroll > *')).toMatch(/flex:\s*0 0 auto/);
  });

  test('E466: the edge fades are clipped to the padding box, as the Map toolbar and the segmented control do', () => {
    const body = phoneRule('.tasks-page-header-scroll');
    const clip = /background-clip:\s*([^;]+);/.exec(body);
    expect(clip, 'background-clip is missing').not.toBeNull();
    expect(clip![1].split(',').map(v => v.trim()))
      .toEqual(['padding-box', 'padding-box', 'padding-box', 'padding-box']);
    expect(body).toMatch(/background-attachment:\s*local, local, scroll, scroll/);
  });

  test('E466: every control of the header keeps the 44 px touch floor up to 768 px, New task included', () => {
    for (const selector of [
      '.tasks-page-header-actions .btn',
      '.tasks-page-header-actions .icon-btn',
      '.tasks-page-header-actions .search-toggle-btn',
      '.tasks-page-header-actions .segmented-option',
    ]) {
      const body = phoneRule(selector);
      expect(body, selector).toMatch(/min-height:\s*44px/);
      expect(body, selector).toMatch(/min-width:\s*44px/);
    }
  });

  test('E469: Search is icon-only on a phone: its word is hidden visually, never removed, and only in the phone block', () => {
    const body = phoneRule('.tasks-page-header-actions .search-toggle-label');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/width:\s*1px/);
    expect(body).toMatch(/height:\s*1px/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    // display:none / visibility:hidden would drop the word from the accessible name.
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
    // Wider than 768 px the word shows as it always did.
    expect(desktop).not.toMatch(/search-toggle-label[^{]*\{[^}]*(position:\s*absolute|clip|display:\s*none)/);
    // The word stays in the markup beside the icon (the accessible name is the aria-label, the word is the fallback).
    expect(tsx).toContain('<span className="search-toggle-label">Search</span>');
  });

  test('E469: the hamburger indent belongs to the TITLE, so a header actions row that wraps under it uses the full width', () => {
    expect(css).toContain(`  .tasks-page-header {
    padding: var(--space-3);
  }

  .tasks-page-header-title {
    padding-left: calc(76px - var(--space-3));
  }`);
    expect(css).not.toMatch(/\.tasks-page-header \{[^}]*padding-left:\s*76px/);
  });

  test('E469: the header controls opt in to the phone long-press label', () => {
    expect(tsx).toContain("import { useLabelTips } from '../components/ui/LabelTip';");
    expect(tsx).toContain('const labelTip = useLabelTips(headerActions);');
    expect(tsx).toContain('<div className="tasks-page-header-actions" ref={setHeaderActions}>');
    expect(tsx).toMatch(/title="Search and filter"\s+data-label-tip=""/);
    expect(tsx).toMatch(/title: view\.tooltip,\s+labelTip: true,/);
    expect(tsx).toMatch(/ariaLabel="More actions"\s+labelTip/);
    expect(tsx).toMatch(/ariaLabel="Create new task"\s+labelTip/);
    expect(tsx).toContain('{labelTip}');
  });

  test('the More menu is lifted out of the row so the scroller cannot clip it', () => {
    const body = phoneRule('.tasks-toolbar-overflow .tasks-overflow-menu');
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/top:\s*auto/);
    expect(body).toMatch(/right:\s*var\(--space-3\)/);
  });

  test('the header controls and the status tabs follow focus (a focused control is scrolled into view)', () => {
    expect(tsx).toContain('useFocusScrollsRow(headerActionsRow)');
    expect(tsx).toContain('useFocusScrollsRow(mobileTabsRow)');
    expect(tsx).toContain('<div className="tasks-page-header-scroll" ref={setHeaderActionsRow}>');
    expect(tsx).toContain('className="tasks-mobile-tabs" ref={setMobileTabsRow}');
  });

  test('E466: New task is the last control of the header actions and sits outside the scrolling line', () => {
    const open = tsx.indexOf('<div className="tasks-page-header-actions" ref={setHeaderActions}>');
    const scroll = tsx.indexOf('<div className="tasks-page-header-scroll" ref={setHeaderActionsRow}>');
    const button = tsx.indexOf('ariaLabel="Create new task"');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(scroll).toBeGreaterThan(open);
    expect(button).toBeGreaterThan(scroll);
    // Every div opened since the scrolling line (itself included) is closed again before the button.
    const between = tsx.slice(scroll, button);
    const opens = (between.match(/<div\b/g) ?? []).length;
    const closes = (between.match(/<\/div>/g) ?? []).length;
    expect(closes - opens).toBe(0);
  });
});
