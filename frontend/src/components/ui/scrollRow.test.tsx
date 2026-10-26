// @vitest-environment jsdom
/**
 * A focused control of a sideways-scrolling toolbar row is brought into view (E464).
 *
 * A browser leaves a control that is half cut off at the edge of the row half
 * cut off when it takes focus. jsdom has no layout, so each test lays the row
 * out by hand: the row is 300px wide, starts at x=20, and the controls follow
 * in order, minus the row's own scroll position.
 */
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { scrollFocusedIntoRow, useFocusScrollsRow } from './scrollRow';

const PORT_LEFT = 20;
const PORT_WIDTH = 300;
const ITEM_WIDTH = 100;

const rect = (left: number, width: number) => ({
  left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({}),
});

/** Lay the row and its controls out: control i starts at the sum of the widths before it. */
function layOut(row: HTMLElement, widths: number[] = [], scrollWidth = 700) {
  row.getBoundingClientRect = () => rect(PORT_LEFT, PORT_WIDTH);
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: PORT_WIDTH });
  let x = 0;
  Array.from(row.children).forEach((node, index) => {
    const width = widths[index] ?? ITEM_WIDTH;
    const at = x;
    (node as HTMLElement).getBoundingClientRect = () => rect(PORT_LEFT + at - row.scrollLeft, width) as DOMRect;
    x += width;
  });
}

const NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];

const Row: React.FC = () => {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useFocusScrollsRow(row);
  return (
    <div ref={setRow} data-testid="row">
      {NAMES.map(name => <button key={name}>{name}</button>)}
    </div>
  );
};

const button = (name: string) => screen.getByRole('button', { name });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('scrollFocusedIntoRow', () => {
  const setup = (widths?: number[], scrollWidth?: number) => {
    const { container } = render(<Row />);
    const row = container.querySelector<HTMLElement>('[data-testid="row"]')!;
    layOut(row, widths, scrollWidth);
    return row;
  };

  test('a control wholly past the right edge is scrolled fully into view', () => {
    const row = setup();
    scrollFocusedIntoRow(row, button('five'));
    const five = button('five').getBoundingClientRect();
    expect(five.right).toBeLessThanOrEqual(PORT_LEFT + PORT_WIDTH);
    expect(five.left).toBeGreaterThanOrEqual(PORT_LEFT);
    expect(row.scrollLeft).toBeGreaterThan(0);
  });

  test('a control half cut off at the right edge (the browser would leave it) is brought fully in', () => {
    const row = setup();
    // "three" spans [200, 300) of the content; scrolled back by 50 it is cut at the right edge.
    row.scrollLeft = 0;
    button('four').getBoundingClientRect = () => rect(PORT_LEFT + 250, ITEM_WIDTH) as DOMRect; // 70 of 100 px visible
    scrollFocusedIntoRow(row, button('four'));
    expect(row.scrollLeft).toBeGreaterThanOrEqual(30);
  });

  test('a control hidden past the left edge scrolls back', () => {
    const row = setup();
    row.scrollLeft = 300;
    layOut(row);
    scrollFocusedIntoRow(row, button('one'));
    expect(row.scrollLeft).toBeLessThan(300);
    expect(button('one').getBoundingClientRect().left).toBeGreaterThanOrEqual(PORT_LEFT);
  });

  test('a control wider than the row is aligned to the start of the row', () => {
    const row = setup([100, 100, 400]);
    scrollFocusedIntoRow(row, button('three'));
    expect(button('three').getBoundingClientRect().left).toBeLessThanOrEqual(PORT_LEFT + 8);
  });

  test('a control already in view does not move the row', () => {
    const row = setup();
    scrollFocusedIntoRow(row, button('two'));
    expect(row.scrollLeft).toBe(0);
  });

  test('a row that does not overflow is left alone (wide screens)', () => {
    const row = setup(undefined, PORT_WIDTH);
    scrollFocusedIntoRow(row, button('four'));
    expect(row.scrollLeft).toBe(0);
  });

  test('a control that is not in the row is ignored', () => {
    const row = setup();
    const stranger = document.createElement('button');
    document.body.appendChild(stranger);
    scrollFocusedIntoRow(row, stranger);
    expect(row.scrollLeft).toBe(0);
    stranger.remove();
  });

  test('it never calls scrollIntoView (that can scroll an ancestor and jump the page)', () => {
    const spy = vi.fn();
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = spy;
    try {
      const row = setup();
      scrollFocusedIntoRow(row, button('six'));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (!had) delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    }
  });
});

describe('useFocusScrollsRow', () => {
  test('focusing a control scrolls the row, and the listener leaves with the row', () => {
    const { container, unmount } = render(<Row />);
    const row = container.querySelector<HTMLElement>('[data-testid="row"]')!;
    layOut(row);
    act(() => { button('five').focus(); });
    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(button('five').getBoundingClientRect().right).toBeLessThanOrEqual(PORT_LEFT + PORT_WIDTH);
    const remove = vi.spyOn(row, 'removeEventListener');
    unmount();
    expect(remove).toHaveBeenCalledWith('focusin', expect.any(Function));
  });
});
