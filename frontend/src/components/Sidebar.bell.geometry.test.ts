/**
 * The bell's GEOMETRY in the closed mobile bar, pinned at the stylesheet
 * (card b1e3b16d, lane L1; design T2).
 *
 * Same method as `Sidebar.geometry.test.ts` and `PluginFrame.geometry.test.ts`
 * (vitest applies no stylesheet, so the rules are read from disk and every
 * number is derived from the declarations of the chrome they must agree with):
 *
 *  - the bell is drawn INSIDE the identity chip's footprint — the chip's right
 *    inset, the menu control's top edge and height — so it adds no floating
 *    band of its own and its bottom edge is the control's;
 *  - the chip reserves at least the bell's width at its right end, so the
 *    handle can never run under the bell;
 *  - the bell is one stacking step above the chip, so a press lands on it;
 *  - the band `PluginFrame.css` reserves for the host's chrome clears the bell
 *    exactly as it clears the two pieces it already measures;
 *  - the chip's width budget is untouched, so at 320px the bell (at the
 *    chip's right end) stays clear of the menu control by at least a row gap.
 *
 * These prove the RULES, not a rendered layout; the rendered check at 390px
 * and in each Theme is the lane's browser pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'Sidebar.css'), 'utf-8');
const frameCss = readFileSync(join(HERE, 'PluginFrame.css'), 'utf-8');
const variables = readFileSync(join(HERE, '..', 'styles', 'variables.css'), 'utf-8');

function spacePx(token: string): number {
  const match = variables.match(new RegExp('--' + token + ':\\s*([0-9.]+)(rem|px);'));
  expect(match, `--${token} is missing from variables.css`).not.toBeNull();
  const value = Number(match![1]);
  return match![2] === 'rem' ? value * 16 : value;
}

function px(body: string, property: string): number {
  const match = body.match(new RegExp('(?:^|[;{\\s])' + property + ':\\s*([0-9.]+)px'));
  expect(match, `${property} is missing`).not.toBeNull();
  return Number(match![1]);
}

function block(source: string, selector: string): string {
  const at = source.indexOf(selector + ' {');
  expect(at, `${selector} is missing`).toBeGreaterThan(-1);
  return source.slice(at + selector.length + 2, source.indexOf('}', at));
}

const control = () => block(css, '.sidebar-hamburger');
const chip = () => block(css, '.sidebar-mobile-account');
const bell = () => block(css, '.sidebar-mobile-bell.notification-bell');
const inChip = () => block(css, '.sidebar-mobile-bell--in-chip.notification-bell');
const reserve = () => block(css, '.sidebar-mobile-account--beside-bell');

describe('the closed-state bell sits inside the identity chip\'s footprint', () => {
  it('reads non-empty sources, so no pin below is vacuous', () => {
    for (const text of [css, frameCss, variables]) expect(text.length).toBeGreaterThan(0);
  });

  it('is fixed at the chip\'s right inset, on the control\'s top edge, at the control\'s height', () => {
    expect(bell()).toContain('position: fixed');
    expect(px(bell(), 'right')).toBe(px(chip(), 'right'));
    expect(px(bell(), 'top')).toBe(px(control(), 'top'));
    expect(px(bell(), 'height')).toBe(px(control(), 'height'));
    expect(px(bell(), 'width')).toBe(px(bell(), 'height'));
    expect(px(bell(), 'border-radius')).toBe(px(control(), 'border-radius'));
  });

  it('is pressable over the chip: one stacking step above it', () => {
    const z = (body: string) => Number(body.match(/z-index:\s*(\d+)/)![1]);
    expect(z(bell())).toBeGreaterThan(z(chip()));
  });

  it('has a reserved cell at the chip\'s right end at least the bell\'s width', () => {
    const calc = reserve().match(/padding-right:\s*calc\(([0-9.]+)px \+ var\(--(space-\d+)\)\)/);
    expect(calc, 'the reserved cell is missing or not written as the bell plus a gap').not.toBeNull();
    expect(Number(calc![1])).toBeGreaterThanOrEqual(px(bell(), 'width'));
    expect(spacePx(calc![2])).toBeGreaterThan(0);
    // padding, not width: the chip's own width budget is untouched
    expect(reserve()).not.toMatch(/(^|[;\s])(max-)?width:/);
  });

  it('inside the chip, draws no box of its own — the chip\'s border and ground are the pill\'s', () => {
    expect(inChip()).toContain('border-color: transparent');
    expect(inChip()).toContain('background: transparent');
    expect(inChip()).toContain('border-left-color: var(--border-subtle)');
  });

  it('standing alone, speaks the chip\'s grammar: its border and its ground', () => {
    expect(bell()).toContain('border: 1px solid var(--border-default)');
    expect(chip()).toContain('border: 1px solid var(--border-default)');
    expect(bell()).toContain('background: var(--bg-surface)');
    expect(chip()).toContain('background: var(--bg-surface)');
  });

  it('never reaches below the control, so the plugin route\'s reserved band still clears all three', () => {
    const bottom = px(bell(), 'top') + px(bell(), 'height');
    expect(bottom).toBeLessThanOrEqual(px(control(), 'top') + px(control(), 'height'));
    const band = frameCss.match(/--plugin-chrome-safe-top:\s*([0-9.]+)(px|rem)\s*;/);
    expect(band, 'the plugin route band is missing').not.toBeNull();
    const bandPx = band![2] === 'rem' ? Number(band![1]) * 16 : Number(band![1]);
    expect(bandPx).toBeGreaterThan(bottom);
  });

  it('at 320px, the bell at the chip\'s right end stays a row gap clear of the menu control', () => {
    const viewport = 320;
    const bellLeft = viewport - px(bell(), 'right') - px(bell(), 'width');
    const controlRight = px(control(), 'left') + px(control(), 'width');
    expect(bellLeft).toBeGreaterThanOrEqual(controlRight + spacePx('space-3'));
  });
});
