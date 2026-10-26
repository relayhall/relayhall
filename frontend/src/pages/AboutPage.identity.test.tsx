// @vitest-environment jsdom
/**
 * The About page against the bytes the deployed artefacts serve (card
 * 6d549392, the recurrence of archived 13bee2dd).
 *
 * The other About suites mock `../utils/releaseInfo`, so the parser never met
 * the producer's real output, and a builtAt format the release tooling stamps
 * blanked the whole panel on every environment without one red test. This
 * file mocks NOTHING between `fetch` and the rendered page: the frontend
 * release manifest and the API root are served in the shapes the images
 * carry, and the assertions read the page.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { AboutPage } from './AboutPage';

// Deployment appearance is a separate source with its own suite; it is not
// the seam under test here.
vi.mock('../services/appearance', () => ({
  loadAppearanceInfo: vi.fn(async () => ({ displayName: null, description: '', links: [], teamMarkdown: '' })),
}));

const FRONTEND_SHA = 'b8210647ce0fdbba0eaa33d3de42f64ec2c72638';
const BACKEND_SHA = '34a0a858d2c4f1e07b9a6c5e3f21d0b8a7c6e5f4';
const FRONTEND_CONTEXT = '2c635d13e9a84f7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b';
const BACKEND_CONTEXT = '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e';
// Python's datetime.isoformat(): an explicit +00:00 offset and microseconds.
// This is the shape the release tooling stamped on 10 Oct 2026.
const ISOFORMAT_BUILT_AT = '2026-10-10T20:17:04.022529+00:00';
const SHELL_BUILT_AT = '2026-10-11T01:23:45Z';

/** GET /release-manifest.json in the shape production served on 10 Oct 2026. */
const SERVED_MANIFEST = {
  service: 'relayhall-frontend',
  sha: FRONTEND_SHA,
  dirty: 'false',
  buildContext: FRONTEND_CONTEXT,
  builtAt: ISOFORMAT_BUILT_AT,
};

/** GET /api/ in the shape production served on 10 Oct 2026. */
const SERVED_API_ROOT = { name: 'RelayHall API', version: '1.0.0-beta.1', environment: 'production', status: 'running' };

interface Reply { status?: number; body: unknown }
let routes: Map<string, Reply[]>;
let calls: string[];

/** Replies are served in order; the last one repeats. */
function serve(url: string, ...replies: Reply[]): void {
  routes.set(url, replies);
}

function callsTo(url: string): number {
  return calls.filter((call) => call === url).length;
}

beforeEach(() => {
  routes = new Map();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const queue = routes.get(url);
    if (!queue || queue.length === 0) return new Response('not found', { status: 404 });
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/** The <dd> paired with the <dt> named `term` inside `scope`. */
function fact(scope: HTMLElement, term: string): HTMLElement {
  const dd = within(scope).getByText(term, { selector: 'dt' }).nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') throw new Error(`no value for ${term}`);
  return dd;
}

async function renderLoaded(): Promise<void> {
  render(<AboutPage />);
  await screen.findByRole('heading', { name: 'Product' });
}

describe('About against the served build identity', () => {
  test('the identity the release tooling stamps today is shown, not refused', async () => {
    serve('/release-manifest.json', { body: SERVED_MANIFEST });
    serve('/api/', { body: SERVED_API_ROOT });
    await renderLoaded();

    expect(screen.queryByText(/Build identity is unavailable/)).toBeNull();
    expect(screen.getByText(FRONTEND_SHA)).toBeInTheDocument();
    expect(screen.getByText(FRONTEND_CONTEXT)).toBeInTheDocument();
    expect(screen.getByText(ISOFORMAT_BUILT_AT)).toBeInTheDocument();
    const frontend = region('Frontend build');
    expect(fact(frontend, 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(fact(frontend, 'Dirty')).toHaveTextContent('false');
    expect(fact(frontend, 'Built at')).toHaveTextContent(ISOFORMAT_BUILT_AT);
    // The machine-readable instant is the same moment, normalised.
    expect(within(fact(frontend, 'Built at')).getByText(ISOFORMAT_BUILT_AT))
      .toHaveAttribute('datetime', '2026-10-10T20:17:04.022Z');
  });

  test('a dirty build reads dirty=true instead of blanking every field', async () => {
    serve('/release-manifest.json', { body: { ...SERVED_MANIFEST, dirty: 'true', builtAt: SHELL_BUILT_AT } });
    serve('/api/', { body: SERVED_API_ROOT });
    await renderLoaded();

    const frontend = region('Frontend build');
    expect(fact(frontend, 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(fact(frontend, 'Dirty')).toHaveTextContent('true');
    expect(fact(frontend, 'Built at')).toHaveTextContent(SHELL_BUILT_AT);
  });

  test('each field the build did not stamp reads Unavailable on its own', async () => {
    // An ad-hoc build with only the commit supplied: the Dockerfile defaults
    // the other arguments to `unknown`.
    serve('/release-manifest.json', {
      body: { service: 'relayhall-frontend', sha: FRONTEND_SHA, dirty: 'unknown', buildContext: 'unknown', builtAt: 'unknown' },
    });
    serve('/api/', { body: SERVED_API_ROOT });
    await renderLoaded();

    const frontend = region('Frontend build');
    expect(fact(frontend, 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(fact(frontend, 'Dirty')).toHaveTextContent('Unavailable');
    expect(fact(frontend, 'Build context')).toHaveTextContent('Unavailable');
    expect(fact(frontend, 'Built at')).toHaveTextContent('Unavailable');
    expect(screen.queryByText(/Build identity is unavailable/)).toBeNull();
  });

  test('Version and API version are the stamped release of each artefact, each build in its own block', async () => {
    serve('/release-manifest.json', { body: { ...SERVED_MANIFEST, version: '1.0.0-beta.19', builtAt: SHELL_BUILT_AT } });
    serve('/api/', {
      body: {
        ...SERVED_API_ROOT,
        version: '1.0.0-beta.19',
        build: {
          service: 'relayhall-backend',
          version: '1.0.0-beta.19',
          sha: BACKEND_SHA,
          dirty: 'false',
          buildContext: BACKEND_CONTEXT,
          builtAt: ISOFORMAT_BUILT_AT,
        },
      },
    });
    await renderLoaded();

    const product = region('Product');
    expect(fact(product, 'Version')).toHaveTextContent('1.0.0-beta.19');
    expect(fact(product, 'API version')).toHaveTextContent('1.0.0-beta.19');
    expect(fact(product, 'Version')).not.toHaveTextContent('unreleased');

    // Attributed: each block shows ITS artefact's identity and not the other's.
    const frontend = region('Frontend build');
    const backend = region('Backend build');
    expect(fact(frontend, 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(fact(frontend, 'Build context')).toHaveTextContent(FRONTEND_CONTEXT);
    expect(fact(frontend, 'Built at')).toHaveTextContent(SHELL_BUILT_AT);
    expect(fact(backend, 'Build SHA')).toHaveTextContent(BACKEND_SHA);
    expect(fact(backend, 'Build context')).toHaveTextContent(BACKEND_CONTEXT);
    expect(fact(backend, 'Built at')).toHaveTextContent(ISOFORMAT_BUILT_AT);
    expect(fact(backend, 'Dirty')).toHaveTextContent('false');

    // Two different commits are a visible conflict, never silently merged.
    expect(screen.getByRole('status', { name: /identities differ/i })).toHaveTextContent(/build SHA/);
  });

  test('matching builds raise no conflict note', async () => {
    serve('/release-manifest.json', { body: { ...SERVED_MANIFEST, version: '1.0.0-beta.19' } });
    serve('/api/', {
      body: {
        ...SERVED_API_ROOT,
        version: '1.0.0-beta.19',
        build: { ...SERVED_MANIFEST, service: 'relayhall-backend', version: '1.0.0-beta.19' },
      },
    });
    await renderLoaded();

    expect(fact(region('Backend build'), 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(screen.queryByRole('status', { name: /identities differ/i })).toBeNull();
  });

  test('a backend from before build identity keeps its version and leaves its build fields Unavailable', async () => {
    // A rollback to an older backend image: /api/ has no `build`, and its
    // version is whatever that code reported.
    serve('/release-manifest.json', { body: { ...SERVED_MANIFEST, version: '1.0.0-beta.19' } });
    serve('/api/', { body: SERVED_API_ROOT });
    await renderLoaded();

    const product = region('Product');
    expect(fact(product, 'Version')).toHaveTextContent('1.0.0-beta.19');
    expect(fact(product, 'API version')).toHaveTextContent('1.0.0-beta.1');
    const backend = region('Backend build');
    for (const term of ['Build SHA', 'Dirty', 'Build context', 'Built at']) {
      expect(fact(backend, term)).toHaveTextContent('Unavailable');
    }
    expect(fact(region('Frontend build'), 'Build SHA')).toHaveTextContent(FRONTEND_SHA);
    expect(screen.getByRole('status', { name: /identities differ/i })).toHaveTextContent(/version/);
  });

  test('an unreleased build says so; an invalid version is Unavailable, not shown', async () => {
    serve('/release-manifest.json', { body: { ...SERVED_MANIFEST, version: '1.0.0-beta.1+unreleased' } });
    serve('/api/', { body: { ...SERVED_API_ROOT, version: 'beta' } });
    await renderLoaded();

    const product = region('Product');
    expect(fact(product, 'Version')).toHaveTextContent('1.0.0-beta.1+unreleased');
    expect(fact(product, 'Version')).toHaveTextContent(/unreleased build/i);
    expect(fact(product, 'API version')).toHaveTextContent('Unavailable');
  });

  test('Retry fetches both sources again and replaces the failure', async () => {
    serve('/release-manifest.json', { status: 503, body: 'down' }, { body: { ...SERVED_MANIFEST, builtAt: SHELL_BUILT_AT } });
    serve('/api/', { body: SERVED_API_ROOT });
    await renderLoaded();

    expect(screen.getByRole('alert')).toHaveTextContent('Build identity is unavailable');
    expect(screen.queryByText(FRONTEND_SHA)).toBeNull();
    expect(callsTo('/release-manifest.json')).toBe(1);
    expect(callsTo('/api/')).toBe(1);

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(FRONTEND_SHA)).toBeInTheDocument();
    expect(callsTo('/release-manifest.json')).toBe(2);
    expect(callsTo('/api/')).toBe(2);
    expect(screen.queryByText(/Build identity is unavailable/)).toBeNull();
  });
});
