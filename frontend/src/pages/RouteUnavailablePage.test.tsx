// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RouteUnavailablePage } from './RouteUnavailablePage';

/**
 * The property under test is INDISTINGUISHABILITY, not prettiness: a path that
 * never existed and a plugin this Account may not see must produce byte-identical
 * output, or the page becomes a resource-existence oracle.
 */
function renderAt(path: string) {
  const { container } = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/real" element={<div>real page</div>} />
        <Route path="*" element={<RouteUnavailablePage pluginsLoading={false} />} />
      </Routes>
    </MemoryRouter>,
  );
  return container.innerHTML;
}

// This repo configures no global auto-cleanup, so renders accumulate in
// document.body and a later screen query matches several copies.
afterEach(cleanup);

describe('the unavailable route tells nobody which case they are in', () => {
  it('renders identical markup for a nonexistent path and a withheld plugin', () => {
    const nonsense = renderAt('/definitely-not-a-thing');
    const withheld = renderAt('/content-engine');
    expect(withheld).toBe(nonsense);
  });

  it('never echoes the requested path back to the caller', () => {
    const html = renderAt('/content-engine/secret-edition');
    for (const leak of ['content-engine', 'secret-edition']) {
      expect(html).not.toContain(leak);
    }
  });

  // Seam coverage, stated precisely. These render through a real <Routes> tree,
  // so they test delivery rather than the component alone. What they do NOT test
  // is App.tsx's own route table -- that is covered only by the source pins at
  // the bottom of this file, and those are textual.
  //
  // Measured, not assumed: inverting the declaration order in this harness so the
  // catch-all comes FIRST does not redden the shadowing test, because React
  // Router v6 ranks matches by specificity rather than declaration order. So the
  // no-shadowing property is the ROUTER's guarantee, not ours, and no mutation of
  // our code can break it. It is kept as a regression guard against a future
  // order-sensitive router or a broader path, and must not be cited as proof that
  // our ordering is what protects real routes.
  it('is reached through the router for an unmatched path', () => {
    expect(renderAt('/definitely-not-a-thing')).toContain('route-unavailable');
  });

  it('never shadows a path a real route claims', () => {
    const html = renderAt('/real');
    expect(html).toContain('real page');
    expect(html).not.toContain('route-unavailable');
  });

  it('offers a safe way back to the dashboard root', () => {
    renderAt('/nope');
    const link = screen.getByRole('link', { name: /return to dashboard/i });
    expect(link.getAttribute('href')).toBe('/');
  });

  it('does not claim unavailability while the registry is still loading', () => {
    render(
      <MemoryRouter initialEntries={['/content-engine']}>
        <RouteUnavailablePage pluginsLoading={true} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/isn’t available/i)).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

/**
 * PROXY PINS, not behavioural tests, and labelled as such. The tests above prove
 * what the page says and that a real <Routes> tree delivers it; they cannot prove
 * App.tsx's own table registers it, because mounting that tree needs every
 * provider. These read the source instead.
 *
 * Scope honestly: they catch the catch-all being DELETED. They do not protect
 * against shadowing, because React Router v6 ranks by specificity and ignores
 * declaration order -- the ordering assertion below is a readability convention,
 * not a safety net, and is labelled that way so nobody later mistakes it for one.
 */
describe('the catch-all is wired, and wired last (source pin)', () => {
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf-8');

  it('registers a catch-all route rendering the unavailable page', () => {
    expect(app).toContain('<Route path="*" element={<RouteUnavailablePage');
  });

  it('keeps it below the plugin routes for readability (ordering is NOT what makes it safe)', () => {
    const plugins = app.indexOf('{!pluginsLoading && pluginRoutes.map');
    const catchAll = app.indexOf('<Route path="*"');
    expect(plugins).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(plugins);
  });

  it('passes the loading flag through, so it cannot cry unavailable too early', () => {
    expect(app).toContain('pluginsLoading={pluginsLoading}');
  });
});
