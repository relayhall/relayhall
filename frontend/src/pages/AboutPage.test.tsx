// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { AboutPage } from './AboutPage';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  api: vi.fn(),
  appearance: vi.fn(),
}));

vi.mock('../utils/releaseInfo', () => ({
  RELAYHALL_VERSION: '2.0.0',
  loadReleaseManifest: mocks.release,
  loadApiInfo: mocks.api,
}));
vi.mock('../services/appearance', () => ({ loadAppearanceInfo: mocks.appearance }));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

function successfulFacts() {
  mocks.release.mockResolvedValue({
    service: 'relayhall-frontend',
    sha: '1234567890abcdef1234567890abcdef12345678',
    dirty: 'false',
    buildContext: 'candidate',
    builtAt: '2026-08-14T01:02:03Z',
  });
  mocks.api.mockResolvedValue({ name: 'RelayHall API', version: '2.0.0' });
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
    expect(await screen.findByText('1234567890abcdef1234567890abcdef12345678')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getByText('candidate')).toBeInTheDocument();
    expect(screen.getByText('API version')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Deployment' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /support Support/ })).toHaveAttribute('href', 'https://support.example.test/');
    expect(screen.queryByText('Unsafe')).not.toBeInTheDocument();
    expect(screen.getByText('On-call team').tagName).toBe('STRONG');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
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
    // Private is the fail-closed build default: labels exist but public links do not.
    expect(screen.getByText('Private working repo')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Private working repo/ })).not.toBeInTheDocument();
  });

  test('fails one source closed without hiding healthy facts, and retries from a blank state', async () => {
    mocks.release
      .mockRejectedValueOnce(new Error('manifest unavailable'))
      .mockResolvedValueOnce({
        service: 'relayhall-frontend', sha: 'f'.repeat(40), dirty: 'false',
        buildContext: 'retry', builtAt: '2026-08-14T02:03:04Z',
      });
    mocks.api.mockResolvedValue({ name: 'RelayHall API', version: '2.0.0' });
    mocks.appearance.mockResolvedValue({ displayName: null, description: '', links: [], teamMarkdown: '' });

    render(<AboutPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Build identity is unavailable'));
    expect(screen.getByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getAllByText('2.0.0')).toHaveLength(2);
    expect(screen.queryByText('f'.repeat(40))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('f'.repeat(40))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  test('footer links the official product page in every build and gates GitHub on the public flag', async () => {
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
    // The test build is a private build: the GitHub link is text, not a link to nowhere.
    expect(screen.queryByRole('link', { name: /GitHub/ })).toBeNull();
    expect(screen.getByText(/GitHub: linked once published/)).toBeInTheDocument();
  });

});
