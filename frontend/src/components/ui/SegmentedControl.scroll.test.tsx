// @vitest-environment jsdom
/**
 * The segmented control's own horizontal scroll (E461).
 *
 * Five tabs do not fit a phone. The tablist must scroll INSIDE its own row,
 * keep the selected tab in view on mount and on every change, and do so without
 * moving any ancestor (a `scrollIntoView` call can scroll the page). jsdom has
 * no layout, so each test lays the control out by hand: the control is 300px
 * wide and every option is 100px wide, in order, minus the control's own
 * scroll position.
 */
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl, scrollSelectedIntoView } from './SegmentedControl';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'SegmentedControl.css'), 'utf-8').replace(/\r\n/g, '\n');

const OPTIONS = ['one', 'two', 'three', 'four', 'five'].map((value) => ({ value, label: value }));
const PORT_LEFT = 20;
const PORT_WIDTH = 300;
const ITEM_WIDTH = 100;

const rect = (left: number, width: number) => ({
  left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({}),
});

/** Lay the control and its options out: option i spans [i*100, i*100+100) in content space. */
function layOut(group: HTMLElement) {
  group.getBoundingClientRect = () => rect(PORT_LEFT, PORT_WIDTH);
  Array.from(group.querySelectorAll<HTMLElement>('[data-segment-value]')).forEach((node, index) => {
    node.getBoundingClientRect = () => rect(PORT_LEFT + index * ITEM_WIDTH - group.scrollLeft, ITEM_WIDTH);
  });
}

const Harness: React.FC<{ initial: string }> = ({ initial }) => {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      ariaLabel="View"
      options={OPTIONS}
      value={value}
      onChange={setValue}
      tabs={{ tabId: (v) => `tab-${v}`, panelId: (v) => `panel-${v}` }}
    />
  );
};

const tablistOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="tablist"]')!;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('scrollSelectedIntoView', () => {
  test('scrolls the control itself so a selected tab past its right edge is fully visible', () => {
    const { container } = render(<Harness initial="one" />);
    const group = tablistOf(container);
    layOut(group);
    fireEvent.click(screen.getByRole('tab', { name: 'five' }));
    layOut(group);
    group.scrollLeft = 0;
    scrollSelectedIntoView(group);
    const five = screen.getByRole('tab', { name: 'five' }).getBoundingClientRect();
    expect(five.right).toBeLessThanOrEqual(PORT_LEFT + PORT_WIDTH);
    expect(five.left).toBeGreaterThanOrEqual(PORT_LEFT);
    expect(group.scrollLeft).toBeGreaterThan(0);
  });

  test('scrolls back when the selected tab is hidden past the left edge', () => {
    const { container } = render(<Harness initial="one" />);
    const group = tablistOf(container);
    layOut(group);
    group.scrollLeft = 200;
    scrollSelectedIntoView(group);
    expect(group.scrollLeft).toBeLessThan(200);
    expect(screen.getByRole('tab', { name: 'one' }).getBoundingClientRect().left).toBeGreaterThanOrEqual(PORT_LEFT);
  });

  test('does nothing when the selected tab is already in view', () => {
    const { container } = render(<Harness initial="two" />);
    const group = tablistOf(container);
    layOut(group);
    group.scrollLeft = 0;
    scrollSelectedIntoView(group);
    expect(group.scrollLeft).toBe(0);
  });
});

describe('the control keeps the selected tab in view without moving the page', () => {
  test('it never calls scrollIntoView (that can scroll an ancestor and jump the page vertically)', () => {
    const spy = vi.fn();
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = spy;
    try {
      render(<Harness initial="five" />);
      fireEvent.keyDown(screen.getByRole('tab', { name: 'five' }), { key: 'Home' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (!had) delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    }
  });

  test('a change of selection runs the scroll again, from the control alone', () => {
    const { container } = render(<Harness initial="one" />);
    const group = tablistOf(container);
    layOut(group);
    const tab = screen.getByRole('tab', { name: 'four' });
    fireEvent.click(tab);
    expect(group.scrollLeft).toBeGreaterThan(0);
    expect(tab.getBoundingClientRect().right).toBeLessThanOrEqual(PORT_LEFT + PORT_WIDTH);
  });

  test('the roving tabindex and the arrow keys are unchanged: arrows move focus AND selection', () => {
    render(<Harness initial="two" />);
    const two = screen.getByRole('tab', { name: 'two' });
    expect(two).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(two, { key: 'ArrowRight' });
    const three = screen.getByRole('tab', { name: 'three' });
    expect(three).toHaveAttribute('aria-selected', 'true');
    expect(three).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'two' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('the stylesheet gives the control its own overflow container on a narrow screen (E461)', () => {
  const MEDIA = '@media (max-width: 768px) {';
  const mediaStart = css.indexOf(`\n${MEDIA}`);
  const media = mediaStart < 0 ? '' : css.slice(mediaStart, css.indexOf('\n}\n', mediaStart + 1));
  const desktop = mediaStart < 0 ? css : css.slice(0, mediaStart);
  const rule = (source: string, selector: string) => {
    const start = source.indexOf(`\n${selector} {`);
    expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf('\n}', start));
  };
  const inMedia = (selector: string) => {
    const start = media.indexOf(`\n  ${selector} {`);
    expect(start, `${selector} is missing from the narrow-screen block`).toBeGreaterThanOrEqual(0);
    return media.slice(start, media.indexOf('\n  }', start));
  };

  test('the stylesheet is not empty (a ?raw import would read as empty and pass vacuously)', () => {
    expect(css.length).toBeGreaterThan(500);
  });

  test('the scrolling recipe lives in one narrow-screen block (768 px and below)', () => {
    expect(mediaStart, 'the narrow-screen block is missing').toBeGreaterThanOrEqual(0);
    expect(media).toContain('.segmented-control');
  });

  test('at 768 px and wider the control is the plain recipe: no scroller, no fade, no flex override', () => {
    // A scrolling box repaints its border and text, so the desktop control must not be one: the
    // pixel-identity proof against the build before E461 (1280 px, three themes) rests on this.
    const body = rule(desktop, '.segmented-control');
    expect(body).not.toMatch(/overflow/);
    expect(body).not.toMatch(/background-image/);
    expect(body).not.toMatch(/background-attachment/);
    expect(body).not.toMatch(/background-clip/);
    expect(body).not.toMatch(/max-width|min-width/);
    expect(desktop).not.toMatch(/overflow-x/);
    expect(desktop).not.toMatch(/flex:\s*0 0 auto/);
    expect(desktop).not.toMatch(/::-webkit-scrollbar/);
  });

  test('on a narrow screen the control scrolls sideways inside itself and never grows past its column', () => {
    const body = inMedia('.segmented-control');
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  test('the options keep their natural width', () => {
    expect(inMedia('.segmented-option')).toMatch(/flex:\s*0 0 auto/);
    expect(rule(desktop, '.segmented-option')).toMatch(/white-space:\s*nowrap/);
  });

  test('the edge fades use tokens and say where content is hidden', () => {
    const body = inMedia('.segmented-control');
    expect(body).toMatch(/background-attachment:\s*local, local, scroll, scroll, scroll/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgba?\(/);
  });

  test('the fade layers are clipped to the padding box so the border is never lit; the colour keeps the border box', () => {
    const clip = /background-clip:\s*([^;]+);/.exec(inMedia('.segmented-control'));
    expect(clip, 'background-clip is missing').not.toBeNull();
    const layers = clip![1].split(',').map(v => v.trim());
    expect(layers).toEqual(['padding-box', 'padding-box', 'padding-box', 'padding-box', 'border-box']);
  });

  test('each cover is solid for at least the width of the shadow it hides', () => {
    const body = inMedia('.segmented-control');
    const size = /background-size:\s*([^;]+);/.exec(body);
    expect(size, 'background-size is missing').not.toBeNull();
    const widths = size![1].split(',').map(v => parseFloat(v.trim()));
    const [coverLeft, coverRight, shadowLeft, shadowRight] = widths;
    expect(widths).toHaveLength(5);
    const covers = [...body.matchAll(/linear-gradient\(to (?:right|left), var\(--bg-app\) (\d+)%, transparent\)/g)];
    expect(covers).toHaveLength(2);
    const solidLeft = (parseFloat(covers[0][1]) / 100) * coverLeft;
    const solidRight = (parseFloat(covers[1][1]) / 100) * coverRight;
    expect(solidLeft).toBeGreaterThanOrEqual(shadowLeft);
    expect(solidRight).toBeGreaterThanOrEqual(shadowRight);
  });
});
