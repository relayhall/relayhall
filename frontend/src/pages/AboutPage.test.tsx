// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { AboutPage } from './AboutPage';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  api: vi.fn(),
  appearance: vi.fn(),
}));

// The parsers stay real; only the two loaders are replaced. The bundled
// version constant is set to a value no source below reports, so a page that
// falls back to it (a package constant passed off as the deployed version)
// shows a string this suite can see.
const STALE_BUNDLE_VERSION = '9.9.9-bundled';
vi.mock('../utils/releaseInfo', async () => ({
  ...(await vi.importActual<typeof import('../utils/releaseInfo')>('../utils/releaseInfo')),
  RELAYHALL_VERSION: '9.9.9-bundled',
  loadReleaseManifest: mocks.release,
  loadApiInfo: mocks.api,
}));
vi.mock('../services/appearance', () => ({ loadAppearanceInfo: mocks.appearance }));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const FRONTEND = {
  service: 'relayhall-frontend' as const,
  version: '2.0.0',
  sha: '1234567890abcdef1234567890abcdef12345678',
  dirty: 'false' as const,
  buildContext: 'candidate',
  builtAt: '2026-08-14T01:02:03Z',
};
const BACKEND = {
  ...FRONTEND,
  service: 'relayhall-backend' as const,
  buildContext: 'backend-candidate',
  builtAt: '2026-08-14T01:05:00Z',
};

function successfulFacts() {
  mocks.release.mockResolvedValue(FRONTEND);
  mocks.api.mockResolvedValue({ name: 'RelayHall API', version: '2.0.0', build: BACKEND });
}

function fact(scope: HTMLElement, term: string): HTMLElement {
  const dd = within(scope).getByText(term, { selector: 'dt' }).nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no value for ${term}`);
  return dd;
}

describe('authenticated About surface', () => {
  test('shows exact release facts and sanitizes deployment Markdown last', async () => {
    successfulFacts();
    mocks.appearance.mockResolvedValue({
      displayName: 'Operations hall',
      description: 'Internal orchestration',
      links: [
        { kind: 'support', label: 'Support', url: 'https://support.example.test' },
        { kind: 'custom', label: 'Unsafe', url: 'javascript:alert(1)' },
      ],
      teamMarkdown: '**On-call team** <img src=x onerror="alert(1)"><script>alert(2)</script> [bad](javascript:alert(3))',
    });

    const { container } = render(<AboutPage />);
    const frontend = await screen.findByRole('region', { name: 'Frontend build' });
    const backend = screen.getByRole('region', { name: 'Backend build' });
    expect(fact(frontend, 'Build SHA')).toHaveTextContent('1234567890abcdef1234567890abcdef12345678');
    expect(fact(frontend, 'Dirty')).toHaveTextContent('false');
    expect(fact(frontend, 'Build context')).toHaveTextContent(/^candidate$/);
    expect(fact(backend, 'Build context')).toHaveTextContent('backend-candidate');
    expect(fact(backend, 'Built at')).toHaveTextContent('2026-08-14T01:05:00Z');
    const product = screen.getByRole('region', { name: 'Product' });
    expect(fact(product, 'Version')).toHaveTextContent(/^2\.0\.0$/);
    expect(fact(product, 'API version')).toHaveTextContent(/^2\.0\.0$/);
    // A complete identity raises neither the failure alert nor the incomplete notice.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Deployment' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /support Support/ })).toHaveAttribute('href', 'https://support.example.test/');
    expect(screen.queryByText('Unsafe')).not.toBeInTheDocument();
    expect(screen.getByText('On-call team').tagName).toBe('STRONG');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  test('never shows the bundled package constant as a deployed version', async () => {
    mocks.release.mockResolvedValue({ ...FRONTEND, version: null });
    mocks.api.mockResolvedValue({ name: 'RelayHall API', version: null, build: null });
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });

    const { container } = render(<AboutPage />);
    const product = await screen.findByRole('region', { name: 'Product' });
    expect(fact(product, 'Version')).toHaveTextContent('Unavailable');
    expect(fact(product, 'API version')).toHaveTextContent('Unavailable');
    expect(container).not.toHaveTextContent(STALE_BUNDLE_VERSION);
  });

  test('suppresses the whole deployment section when every deployment field is blank', async () => {
    successfulFacts();
    mocks.appearance.mockResolvedValue({
      displayName: null,
      description: '   ',
      links: [{ kind: 'custom', label: ' ', url: 'https://example.test' }],
      teamMarkdown: '\n',
    });

    render(<AboutPage />);
    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Deployment' })).not.toBeInTheDocument();
  });

  // E504: the public repository exists, so the product links are links in
  // every build. The test build sets no build flag at all, which is the exact
  // case that used to render them as plain text.
  test('the product links are real links to the public repository in every build', async () => {
    successfulFacts();
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });
    render(<AboutPage />);
    const nav = await screen.findByRole('navigation', { name: 'RelayHall product links' });
    const expected: Array<[string, string]> = [
      ['MIT licence', 'https://github.com/relayhall/relayhall/blob/main/LICENSE'],
      ['Source', 'https://github.com/relayhall/relayhall'],
      ['Documentation', 'https://github.com/relayhall/relayhall/tree/main/docs'],
      ['Blueprint authoring and use guide', 'https://github.com/relayhall/relayhall/blob/main/docs/blueprints/README.md'],
      ['Report a problem', 'https://github.com/relayhall/relayhall/issues/new/choose'],
    ];
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(expected.map(([, href]) => href));
    for (const [name, href] of expected) {
      const link = within(nav).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer']);
    }
    // Nothing in the row is left as a plain-text placeholder.
    expect(within(nav).queryByText(/Private working repo/)).toBeNull();
  });

  test('fails one source closed without hiding healthy facts, and Retry fetches every source again', async () => {
    mocks.release
      .mockRejectedValueOnce(new Error('manifest unavailable'))
      .mockResolvedValueOnce({ ...FRONTEND, sha: 'f'.repeat(40), buildContext: 'retry', builtAt: '2026-08-14T02:03:04Z' });
    mocks.api.mockResolvedValue({ name: 'RelayHall API', version: '2.0.0', build: BACKEND });
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });

    render(<AboutPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Build identity is unavailable'));
    const product = screen.getByRole('region', { name: 'Product' });
    expect(fact(product, 'Version')).toHaveTextContent('Unavailable');
    expect(fact(product, 'API version')).toHaveTextContent('2.0.0');
    // The backend identity is a different source and stays visible.
    expect(fact(screen.getByRole('region', { name: 'Backend build' }), 'Build SHA')).toHaveTextContent(BACKEND.sha);
    expect(fact(screen.getByRole('region', { name: 'Frontend build' }), 'Build SHA')).toHaveTextContent('Unavailable');
    expect(screen.queryByText('f'.repeat(40))).not.toBeInTheDocument();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('f'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.appearance).toHaveBeenCalledTimes(2);
  });

  test('an incomplete identity offers Retry without raising an alert', async () => {
    mocks.release.mockResolvedValue({ ...FRONTEND, builtAt: null });
    mocks.api.mockResolvedValue({ name: 'RelayHall API', version: '2.0.0', build: BACKEND });
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });

    render(<AboutPage />);
    const frontend = await screen.findByRole('region', { name: 'Frontend build' });
    expect(fact(frontend, 'Built at')).toHaveTextContent('Unavailable');
    expect(fact(frontend, 'Build SHA')).toHaveTextContent(FRONTEND.sha);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Some build identity fields are unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(2));
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  test('with every source down the page still renders each field as Unavailable', async () => {
    mocks.release.mockRejectedValue(new Error('down'));
    mocks.api.mockRejectedValue(new Error('down'));
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });

    render(<AboutPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Build identity and API version are unavailable'));
    for (const name of ['Frontend build', 'Backend build']) {
      const scope = screen.getByRole('region', { name });
      for (const term of ['Build SHA', 'Dirty', 'Build context', 'Built at']) {
        expect(fact(scope, term)).toHaveTextContent('Unavailable');
      }
    }
    // One Retry, in the alert; the incomplete notice does not duplicate it.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  test('footer links the official product page and GitHub in every build', async () => {
    successfulFacts();
    mocks.appearance.mockResolvedValue({
      displayName: 'Operations hall',
      description: 'Internal orchestration',
      links: [
        { kind: 'support', label: 'Support', url: 'https://support.example.test' },
        { kind: 'custom', label: 'Unsafe', url: 'javascript:alert(1)' },
      ],
      teamMarkdown: '**On-call team** <img src=x onerror="alert(1)"><script>alert(2)</script> [bad](javascript:alert(3))',
    });
    render(<AboutPage />);
    await waitFor(() => expect(screen.getByRole('link', { name: /relayhall\.com/ })).toHaveAttribute('href', 'https://relayhall.com'));
    const github = screen.getByRole('link', { name: /GitHub/ });
    expect(github).toHaveAttribute('href', 'https://github.com/relayhall/relayhall');
    expect(github).toHaveAttribute('target', '_blank');
    expect(github.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer']);
    expect(screen.queryByText(/linked once published/)).toBeNull();
  });

});
