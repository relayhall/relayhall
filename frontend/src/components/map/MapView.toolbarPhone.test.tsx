// @vitest-environment jsdom
/**
 * The Map toolbar on a phone (E464).
 *
 * At 768 px and below the whole control area is ONE line that scrolls sideways
 * inside itself (the Action Center tab row pattern, E461); at 769 px and wider
 * nothing changes, so the rules the desktop toolbar was built from are pinned
 * byte for byte below. jsdom has no layout: the one-row, no-wrap and
 * pixel-identity proofs are the real-browser census
 * (scripts/mobile-overflow-census.mjs) and the pixel diff recorded with the
 * change; this file pins what a test can see, the stylesheet and the order and
 * names of the controls.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ThemeProvider } from '../../contexts/ThemeContext';
import { MapView } from './MapView';
import { fetchMapGraph, type MapGraphResponse } from './mapGraphApi';

vi.mock('./mapGraphApi', () => ({ fetchMapGraph: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, connected: false, send: () => {} }),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'MapView.css'), 'utf-8').replace(/\r\n/g, '\n');

const MEDIA = '@media (max-width: 768px) {';
const mediaStart = css.indexOf(`\n${MEDIA}\n  .map-toolbar {`);
const mediaEnd = mediaStart < 0 ? -1 : css.indexOf('\n}\n', mediaStart + 1);
const media = mediaStart < 0 ? '' : css.slice(mediaStart, mediaEnd);
const desktop = mediaStart < 0 ? css : css.slice(0, mediaStart) + css.slice(mediaEnd + 2);

const ruleIn = (source: string, selector: string) => {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return source.slice(start + 1, source.indexOf('\n}', start) + 3);
};
const phoneRule = (selector: string) => {
  const start = media.indexOf(`\n  ${selector} {`);
  expect(start, `${selector} is missing from the phone block`).toBeGreaterThanOrEqual(0);
  return media.slice(start, media.indexOf('\n  }', start));
};

describe('the stylesheet: one scrolling line at 768 px and below, the desktop toolbar untouched', () => {
  test('the stylesheet is not empty and the phone block exists exactly once', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(mediaStart, 'the phone block is missing').toBeGreaterThanOrEqual(0);
    expect(css.split(MEDIA).length - 1).toBe(1);
  });

  test('the desktop toolbar rules are byte for byte what they were before E464', () => {
    expect(ruleIn(desktop, '.map-toolbar')).toBe(`.map-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  flex: none;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
}
`);
    expect(ruleIn(desktop, '.map-toolbar-group')).toBe(`.map-toolbar-group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-segmented);
}
`);
    expect(ruleIn(desktop, '.map-scope-count')).toBe(`.map-scope-count {
  margin-left: auto;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-tertiary);
  white-space: nowrap;
}
`);
    expect(ruleIn(desktop, '.map-toolbar-reports')).toBe(`.map-toolbar-reports {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
`);
    expect(ruleIn(desktop, '.map-toolbar-label')).toBe(`.map-toolbar-label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
}
`);
  });

  test('nothing outside the phone block scrolls, clips or fades the toolbar', () => {
    // A scrolling box repaints its border and its text: the desktop toolbar must not be one.
    expect(desktop).not.toMatch(/\.map-toolbar[^{]*\{[^}]*overflow/);
    expect(desktop).not.toMatch(/\.map-toolbar[^{]*\{[^}]*flex:\s*0 0 auto/);
    expect(desktop).not.toMatch(/\.map-toolbar[^{]*::-webkit-scrollbar/);
    expect(desktop).not.toMatch(/\.map-toolbar[^{]*\{[^}]*background-(image|attachment|clip)/);
  });

  test('every rule of the phone block names the toolbar and nothing else', () => {
    const selectors = [...media.matchAll(/\n  ([^\n{}]+) \{/g)].map(match => match[1]);
    expect(selectors).toEqual([
      '.map-toolbar',
      '.map-toolbar::-webkit-scrollbar',
      '.map-toolbar > *',
      '.map-toolbar .btn',
      '.map-toolbar .icon-btn',
      '.map-toolbar .segmented-control',
      '.map-toolbar .segmented-option',
      '.map-toolbar-iconbtn.btn',
      '.map-toolbar-iconbtn.btn .btn-text',
      '.map-toolbar .map-scope-count',
    ]);
  });

  test('on a phone the row is one line that scrolls sideways inside itself and never grows past its column', () => {
    const body = phoneRule('.map-toolbar');
    expect(body).toMatch(/flex-wrap:\s*nowrap/);
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/overflow-y:\s*hidden/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/overscroll-behavior-x:\s*contain/);
    expect(body).toMatch(/scrollbar-width:\s*none/);
    expect(phoneRule('.map-toolbar::-webkit-scrollbar')).toMatch(/display:\s*none/);
  });

  test('every control keeps its natural width and the touch floor, and nothing wraps inside a control', () => {
    expect(phoneRule('.map-toolbar > *')).toMatch(/flex:\s*0 0 auto/);
    expect(phoneRule('.map-toolbar .btn')).toMatch(/min-height:\s*44px/);
    expect(phoneRule('.map-toolbar .btn')).toMatch(/white-space:\s*nowrap/);
    expect(phoneRule('.map-toolbar .btn')).toMatch(/max-width:\s*none/);
    expect(phoneRule('.map-toolbar .icon-btn')).toMatch(/min-width:\s*44px/);
    expect(phoneRule('.map-toolbar .icon-btn')).toMatch(/min-height:\s*44px/);
    expect(phoneRule('.map-toolbar .segmented-control')).toMatch(/max-width:\s*none/);
  });

  test('the edge fades use tokens, show only where content is hidden and never light the border', () => {
    const body = phoneRule('.map-toolbar');
    expect(body).toMatch(/background-attachment:\s*local, local, scroll, scroll, scroll/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgba?\(/);
    const clip = /background-clip:\s*([^;]+);/.exec(body);
    expect(clip, 'background-clip is missing').not.toBeNull();
    expect(clip![1].split(',').map(v => v.trim()))
      .toEqual(['padding-box', 'padding-box', 'padding-box', 'padding-box', 'border-box']);
    // Each cover is solid for at least the width of the shadow it hides, in the surface colour.
    const size = /background-size:\s*([^;]+);/.exec(body);
    expect(size, 'background-size is missing').not.toBeNull();
    const widths = size![1].split(',').map(v => parseFloat(v.trim()));
    const covers = [...body.matchAll(/linear-gradient\(to (?:right|left), var\(--bg-surface\) (\d+)%, transparent\)/g)];
    expect(covers).toHaveLength(2);
    expect((parseFloat(covers[0][1]) / 100) * widths[0]).toBeGreaterThanOrEqual(widths[2]);
    expect((parseFloat(covers[1][1]) / 100) * widths[1]).toBeGreaterThanOrEqual(widths[3]);
  });

  test('the desktop count still sits at the right end of the wrapped toolbar', () => {
    expect(ruleIn(desktop, '.map-scope-count')).toMatch(/margin-left:\s*auto/);
    expect(desktop).not.toMatch(/map-scope-count[^{]*\{[^}]*order:/);
  });

  test('E466: on a phone the count is the START of the row, so it is seen without scrolling', () => {
    const body = phoneRule('.map-toolbar .map-scope-count');
    expect(body).toMatch(/order:\s*-1/);
    expect(body).toMatch(/margin-left:\s*0/);
  });

  test('E466: Re-pack layout, Show as list and Map and list are icon-only squares on a phone', () => {
    const square = phoneRule('.map-toolbar-iconbtn.btn');
    expect(square).toMatch(/min-width:\s*44px/);
    expect(square).toMatch(/padding:\s*0/);
    // The text is hidden VISUALLY, never removed: display:none / visibility:hidden would drop the accessible name.
    const text = phoneRule('.map-toolbar-iconbtn.btn .btn-text');
    expect(text).toMatch(/position:\s*absolute/);
    expect(text).toMatch(/width:\s*1px/);
    expect(text).toMatch(/height:\s*1px/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(text).not.toMatch(/display:\s*none/);
    expect(text).not.toMatch(/visibility:\s*hidden/);
    // Nothing of it reaches the desktop toolbar.
    expect(desktop).not.toMatch(/map-toolbar-iconbtn/);
  });

  test('E466: the segmented options of the row keep the 44 px touch floor up to 768 px', () => {
    const body = phoneRule('.map-toolbar .segmented-option');
    expect(body).toMatch(/min-height:\s*44px/);
    expect(body).toMatch(/min-width:\s*44px/);
  });
});

describe('the toolbar markup: the same controls, in the same tab order, each with a name', () => {
  const graph = {
    nodes: [{ id: 't1', title: 'One', status: 'todo', priority: 'normal', project: 'Alpha', phaseId: null, updated: '2026-10-20T07:00:00.000Z' }],
    edges: [], phases: [], reports: [], fullCount: 1, generatedAt: '2026-10-20T08:00:00Z',
  } as unknown as MapGraphResponse;
  let client: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({
      organization: 'horizontal', altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
    vi.mocked(fetchMapGraph).mockReset();
    vi.mocked(fetchMapGraph).mockResolvedValue(graph);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

  test('one flat row: zoom, re-pack, organization, reports, list, split, then the count', async () => {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ThemeProvider authenticated={false}>
          <MapView query={{}} onOpenTask={() => {}} />
        </ThemeProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/tasks? in view/)).toBeInTheDocument());
    const toolbar = document.querySelector('.map-toolbar') as HTMLElement;
    const controls = [...toolbar.querySelectorAll<HTMLElement>('button')];
    const names = controls.map(control => control.getAttribute('aria-label')
      ?? control.textContent?.trim() ?? '');
    expect(names).toEqual([
      'Zoom out', 'Zoom in', 'Fit view', 'Re-pack layout',
      'Horizontal', 'Vertical', 'Collapsed', 'Expanded',
      'Show as list', 'Map and list',
    ]);
    // The count follows the last control inside the same row.
    const count = toolbar.querySelector('.map-scope-count') as HTMLElement;
    expect(count).toHaveTextContent(/tasks? in view/);
    expect(controls[controls.length - 1].compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing in the row is a tab trap: only the selected option of each group is a tab stop.
    const radios = [...toolbar.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.filter(radio => radio.getAttribute('tabindex') === '0')).toHaveLength(2);
    // Every control has a name a screen reader can say.
    for (const control of controls) {
      expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim()).not.toBe('');
    }
  });

  test('E466: the three icon-only buttons keep their visible words as the accessible name, add a tooltip and keep their icon', async () => {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ThemeProvider authenticated={false}>
          <MapView query={{}} onOpenTask={() => {}} />
        </ThemeProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/tasks? in view/)).toBeInTheDocument());
    for (const name of ['Re-pack layout', 'Show as list', 'Map and list']) {
      const control = screen.getByRole('button', { name });
      expect(control, name).toHaveClass('map-toolbar-iconbtn');
      expect(control, name).toHaveAttribute('title', name);
      expect(control.querySelector('.btn-icon svg'), `${name} icon`).not.toBeNull();
      expect(control.querySelector('.btn-text'), `${name} text`).toHaveTextContent(name);
    }
    // No other control of the row became icon-only.
    const iconOnly = [...document.querySelectorAll('.map-toolbar .map-toolbar-iconbtn')];
    expect(iconOnly).toHaveLength(3);
    // The tooltip follows the toggled name.
    fireEvent.click(screen.getByRole('button', { name: 'Show as list' }));
    const back = screen.getByRole('button', { name: 'Show as map' });
    expect(back).toHaveAttribute('title', 'Show as map');
    expect(back).toHaveAttribute('aria-pressed', 'true');
  });

  test('E469: every icon-only button of the row carries the long-press label, and no text control does', async () => {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ThemeProvider authenticated={false}>
          <MapView query={{}} onOpenTask={() => {}} />
        </ThemeProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/tasks? in view/)).toBeInTheDocument());
    const toolbar = document.querySelector('.map-toolbar') as HTMLElement;
    const labelled = [...toolbar.querySelectorAll<HTMLElement>('[data-label-tip]')]
      .map(control => control.getAttribute('aria-label') ?? control.textContent?.trim());
    expect(labelled).toEqual(['Zoom out', 'Zoom in', 'Fit view', 'Re-pack layout', 'Show as list', 'Map and list']);
    // The segmented options have visible words on a phone: no label.
    expect(toolbar.querySelectorAll('[role="radio"][data-label-tip]')).toHaveLength(0);
  });

  test('E466: the toolbar with its icon-only buttons is axe-clean (every button has a name)', async () => {
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ThemeProvider authenticated={false}>
          <MapView query={{}} onOpenTask={() => {}} />
        </ThemeProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/tasks? in view/)).toBeInTheDocument());
    const toolbar = container.querySelector('.map-toolbar') as HTMLElement;
    // jsdom has no layout: contrast is the census's job (a real browser); names and ARIA are measured here.
    const result = await axe.run(toolbar, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`)).toEqual([]);
    // An explicit name check beside it: every button has a non-empty name in the accessibility tree.
    for (const button of screen.getAllByRole('button')) {
      expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim(), button.outerHTML.slice(0, 80)).not.toBe('');
    }
  });
});
