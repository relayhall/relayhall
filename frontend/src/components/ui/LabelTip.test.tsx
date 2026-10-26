// @vitest-environment jsdom
/**
 * The visible label of an icon-only toolbar button on a phone (E469).
 *
 * jsdom has no layout and no touch: these tests drive the events a phone sends
 * (pointerdown / pointerup / click with pointerType "touch") on fake timers and
 * read the bubble back. The real-browser proof (a long press on every icon-only
 * button of both rows at 375 and 320 px, the label inside the viewport, hidden
 * on release, axe in three themes with a label shown) is the census
 * (scripts/mobile-overflow-census.mjs).
 */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Button } from '../Button';
import { IconButton } from './IconButton';
import { SegmentedControl } from './SegmentedControl';
import {
  CLICK_SUPPRESS_MS,
  HOVER_DELAY_MS,
  HOVER_LEAVE_GRACE_MS,
  LABEL_TIP_PHONE_QUERY,
  LONG_PRESS_SLOP_PX,
  LONG_PRESS_MS,
  SCROLL_GRACE_MS,
  useLabelTips,
} from './LabelTip';

const clicks = { zoom: vi.fn(), repack: vi.fn(), plain: vi.fn(), board: vi.fn() };

function Host() {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const tip = useLabelTips(row);
  return (
    <>
      <div ref={setRow} data-testid="row">
        <IconButton icon={<span aria-hidden="true">-</span>} ariaLabel="Zoom out" labelTip onClick={clicks.zoom} />
        <Button variant="secondary" size="compact" labelTip title="Re-pack layout"
          ariaDescribedBy="repack-hint" onClick={clicks.repack}>
          Re-pack layout
        </Button>
        <span id="repack-hint">Lays the Map out afresh.</span>
        <SegmentedControl
          ariaLabel="Task view"
          value="board"
          onChange={clicks.board}
          options={[
            { value: 'board', label: 'B', ariaLabel: 'Board', title: 'The Kanban board', labelTip: true },
            { value: 'map', label: 'M', ariaLabel: 'Map', title: 'Map', labelTip: true },
          ]}
        />
        <button type="button" data-testid="plain" onClick={clicks.plain}>Plain</button>
      </div>
      {tip}
    </>
  );
}

function pointer(element: Element, type: string, init: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'touch' });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => { element.dispatchEvent(event); });
  return event;
}

const tooltip = () => screen.queryByRole('tooltip');
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('768'), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(clicks).forEach(mock => mock.mockClear());
  setPhone(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the ruled numbers', () => {
  // E469 names "about 500 ms" and the phone range of the toolbar rules (768 px). The other tests read the constants;
  // this one pins them to the ruling, so editing a constant and its tests together cannot go unnoticed.
  test('the long press is 500 ms, the phone range is 768 px and a press of more than 10 px is a drag', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LABEL_TIP_PHONE_QUERY).toBe('(max-width: 768px)');
    expect(LONG_PRESS_SLOP_PX).toBe(10);
  });
});

describe('a long press on an icon-only button shows its label', () => {
  test('the label appears at 500 ms, not before, and is a role=tooltip bubble with the words', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS - 1);
    expect(tooltip()).toBeNull();
    advance(1);
    expect(tooltip()).toHaveTextContent('Zoom out');
    expect(tooltip()).toHaveAttribute('data-source', 'press');
  });

  test('the long press fires no click: the click the browser may send on release is swallowed', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS + 100);
    pointer(zoom, 'pointerup');
    const click = fireEvent.click(zoom);
    expect(clicks.zoom).not.toHaveBeenCalled();
    expect(click).toBe(false); // defaultPrevented
    // ... and only that one click: the next, a real tap, acts.
    fireEvent.click(zoom);
    expect(clicks.zoom).toHaveBeenCalledTimes(1);
  });

  test('a click long after the release is a real click', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS + 100);
    pointer(zoom, 'pointerup');
    advance(CLICK_SUPPRESS_MS + 50);
    fireEvent.click(zoom);
    expect(clicks.zoom).toHaveBeenCalledTimes(1);
  });

  test('a quick tap shows nothing and clicks as usual', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(120);
    pointer(zoom, 'pointerup');
    fireEvent.click(zoom);
    advance(LONG_PRESS_MS * 2);
    expect(tooltip()).toBeNull();
    expect(clicks.zoom).toHaveBeenCalledTimes(1);
  });

  test('the label goes on release', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(tooltip()).not.toBeNull();
    pointer(zoom, 'pointerup');
    expect(tooltip()).toBeNull();
  });

  test('the label goes when the browser cancels the touch (a scroll began)', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(tooltip()).not.toBeNull();
    pointer(zoom, 'pointercancel');
    expect(tooltip()).toBeNull();
  });

  test('a finger that moves more than 10 px is a drag, not a long press', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown', { clientX: 10, clientY: 10 });
    advance(200);
    pointer(zoom, 'pointermove', { clientX: 30, clientY: 10 });
    advance(LONG_PRESS_MS * 2);
    expect(tooltip()).toBeNull();
  });

  test('the press\'s own context menu is prevented, a context menu elsewhere is not', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { zoom.dispatchEvent(menu); });
    expect(menu.defaultPrevented).toBe(true);
    pointer(zoom, 'pointerup');
    advance(CLICK_SUPPRESS_MS + 50);
    const later = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { zoom.dispatchEvent(later); });
    expect(later.defaultPrevented).toBe(false);
  });

  test('every opted-in kind of control is covered: IconButton, Button, a SegmentedControl option', () => {
    render(<Host />);
    for (const [name, words] of [['Zoom out', 'Zoom out'], ['Re-pack layout', 'Re-pack layout'], ['Board', 'The Kanban board']] as const) {
      const control = screen.getByRole(name === 'Board' ? 'radio' : 'button', { name });
      pointer(control, 'pointerdown');
      advance(LONG_PRESS_MS);
      expect(tooltip(), name).toHaveTextContent(words);
      pointer(control, 'pointerup');
      advance(CLICK_SUPPRESS_MS + 50);
    }
  });

  test('a control that did not opt in has no label', () => {
    render(<Host />);
    pointer(screen.getByTestId('plain'), 'pointerdown');
    advance(LONG_PRESS_MS * 2);
    expect(tooltip()).toBeNull();
  });

  test('a mouse press is a click, never a long press', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown', { pointerType: 'mouse' });
    advance(LONG_PRESS_MS * 2);
    expect(tooltip()).toBeNull();
  });
});

describe('hover and keyboard focus', () => {
  test('a mouse resting on the control shows the label after the hover delay, and it goes after the pointer leaves', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerover', { pointerType: 'mouse' });
    advance(HOVER_DELAY_MS - 1);
    expect(tooltip()).toBeNull();
    advance(1);
    expect(tooltip()).toHaveTextContent('Zoom out');
    pointer(zoom, 'pointerout', { pointerType: 'mouse', relatedTarget: document.body });
    advance(HOVER_LEAVE_GRACE_MS + 1);
    expect(tooltip()).toBeNull();
  });

  test('a mouse that leaves before the delay shows nothing', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerover', { pointerType: 'mouse' });
    advance(HOVER_DELAY_MS - 50);
    pointer(zoom, 'pointerout', { pointerType: 'mouse', relatedTarget: document.body });
    advance(HOVER_DELAY_MS * 2);
    expect(tooltip()).toBeNull();
  });

  test('the pointer can travel onto the label without it going (WCAG 1.4.13)', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerover', { pointerType: 'mouse' });
    advance(HOVER_DELAY_MS);
    pointer(zoom, 'pointerout', { pointerType: 'mouse', relatedTarget: document.body });
    advance(HOVER_LEAVE_GRACE_MS - 20);
    fireEvent.pointerEnter(tooltip()!);
    advance(HOVER_LEAVE_GRACE_MS * 3);
    expect(tooltip()).not.toBeNull();
  });

  test('keyboard focus shows the label and blur hides it', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => { zoom.focus(); });
    expect(tooltip()).toHaveTextContent('Zoom out');
    act(() => { zoom.blur(); });
    expect(tooltip()).toBeNull();
  });

  test('focus that follows a pointer press shows nothing (a tap is not keyboard use)', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.pointerDown(document.body);
    vi.spyOn(zoom, 'matches').mockImplementation(() => { throw new SyntaxError('no :focus-visible'); });
    act(() => { zoom.focus(); });
    expect(tooltip()).toBeNull();
  });

  test('Escape hides it', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => { zoom.focus(); });
    expect(tooltip()).not.toBeNull();
    fireEvent.keyDown(zoom, { key: 'Escape' });
    expect(tooltip()).toBeNull();
  });

  test('a scroll hides it, but not the scroll the focus itself causes', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => { zoom.focus(); });
    act(() => { fireEvent.scroll(screen.getByTestId('row')); });
    expect(tooltip(), 'the scroll that the focus caused').not.toBeNull();
    advance(SCROLL_GRACE_MS + 10);
    act(() => { fireEvent.scroll(screen.getByTestId('row')); });
    expect(tooltip()).toBeNull();
  });
});

describe('only on a phone', () => {
  test('wider than 768 px nothing shows: no long press, no hover, no focus label', () => {
    setPhone(false);
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS * 2);
    pointer(zoom, 'pointerup');
    pointer(zoom, 'pointerover', { pointerType: 'mouse' });
    advance(HOVER_DELAY_MS * 2);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => { zoom.focus(); });
    expect(tooltip()).toBeNull();
    // ... and a click after a long hold is an ordinary click: nothing swallows it.
    fireEvent.click(zoom);
    expect(clicks.zoom).toHaveBeenCalledTimes(1);
  });
});

describe('accessibility', () => {
  test('aria-describedby points at the bubble only while it is shown, when it adds words', () => {
    render(<Host />);
    const board = screen.getByRole('radio', { name: 'Board' });
    expect(board).not.toHaveAttribute('aria-describedby');
    pointer(board, 'pointerdown');
    advance(LONG_PRESS_MS);
    const bubble = tooltip()!;
    expect(board).toHaveAttribute('aria-describedby', bubble.id);
    pointer(board, 'pointerup');
    expect(board).not.toHaveAttribute('aria-describedby');
  });

  test('a label the accessible name already says is not announced a second time', () => {
    render(<Host />);
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(tooltip()).not.toBeNull();
    expect(zoom).not.toHaveAttribute('aria-describedby');
  });

  test('an existing aria-describedby is kept and restored', () => {
    render(<Host />);
    const repack = screen.getByRole('button', { name: 'Re-pack layout' });
    expect(repack).toHaveAttribute('aria-describedby', 'repack-hint');
    pointer(repack, 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(repack.getAttribute('aria-describedby')).toContain('repack-hint');
    pointer(repack, 'pointerup');
    expect(repack).toHaveAttribute('aria-describedby', 'repack-hint');
  });

  test('the native title is set aside while the label shows and put back after', () => {
    render(<Host />);
    const repack = screen.getByRole('button', { name: 'Re-pack layout' });
    pointer(repack, 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(repack).not.toHaveAttribute('title');
    pointer(repack, 'pointerup');
    expect(repack).toHaveAttribute('title', 'Re-pack layout');
  });

  test('the accessible name is unchanged by the label', () => {
    render(<Host />);
    const names = () => screen.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent);
    const before = names();
    pointer(screen.getByRole('button', { name: 'Zoom out' }), 'pointerdown');
    advance(LONG_PRESS_MS);
    expect(names()).toEqual(before);
  });

  test.each(['relay-dark', 'relay-light', 'high-contrast'])('axe finds nothing with a label shown (%s)', async theme => {
    vi.useRealTimers();
    document.documentElement.setAttribute('data-theme', theme);
    render(<Host />);
    const board = screen.getByRole('radio', { name: 'Board' });
    pointer(board, 'pointerdown');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 50)); });
    expect(tooltip()).not.toBeNull();
    const result = await axe.run(document.body, {
      // jsdom has no rendering: the census reads real contrast; a test host is not a page.
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map(v => v.id)).toEqual([]);
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('placement', () => {
  const sizeOf = (width: number, height: number) => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
  };
  const place = (box: { left: number; top: number; width: number; height: number }) => {
    const zoom = screen.getByRole('button', { name: 'Zoom out' });
    zoom.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) });
    pointer(zoom, 'pointerdown');
    advance(LONG_PRESS_MS);
    return tooltip() as HTMLElement;
  };

  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
  });

  test('centred above the control when there is room', () => {
    sizeOf(100, 28);
    render(<Host />);
    const bubble = place({ left: 110, top: 200, width: 44, height: 44 });
    expect(bubble).toHaveAttribute('data-placement', 'above');
    expect(bubble.style.left).toBe('82px'); // 110 + 22 - 50
    expect(bubble.style.top).toBe('164px'); // 200 - 28 - 8
  });

  test('flips below when there is no room above', () => {
    sizeOf(100, 28);
    render(<Host />);
    const bubble = place({ left: 110, top: 12, width: 44, height: 44 });
    expect(bubble).toHaveAttribute('data-placement', 'below');
    expect(bubble.style.top).toBe('64px'); // 12 + 44 + 8
  });

  test('clamped inside the screen at the left and at the right edge', () => {
    sizeOf(120, 28);
    render(<Host />);
    expect(place({ left: 0, top: 200, width: 44, height: 44 }).style.left).toBe('8px');
    cleanup();
    render(<Host />);
    expect(place({ left: 276, top: 200, width: 44, height: 44 }).style.left).toBe('192px'); // 320 - 120 - 8
  });
});

describe('the kit props', () => {
  test('labelTip writes data-label-tip on IconButton, Button and a SegmentedControl option, and nothing otherwise', () => {
    render(<Host />);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('data-label-tip');
    expect(screen.getByRole('button', { name: 'Re-pack layout' })).toHaveAttribute('data-label-tip');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('data-label-tip');
    expect(screen.getByTestId('plain')).not.toHaveAttribute('data-label-tip');
    cleanup();
    render(<><IconButton icon={null} ariaLabel="Close" /><Button>Go</Button></>);
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute('data-label-tip');
    expect(screen.getByRole('button', { name: 'Go' })).not.toHaveAttribute('data-label-tip');
  });
});
