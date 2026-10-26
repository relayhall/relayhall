// @vitest-environment jsdom
import { RELAYHALL_VERSION } from '../utils/releaseInfo';
import { render, screen, cleanup, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginPage } from './LoginPage';
import { DEFAULT_CONFIG } from '../config/relayhall';
import { RelayHallPublicConfig } from '../config/relayhall';

vi.mock('../utils/auth', () => ({
  auth: { login: vi.fn(), isAuthenticated: () => false },
}));

const mockConfig = vi.hoisted(() => ({ current: null as RelayHallPublicConfig | null }));
vi.mock('../contexts/RelayHallConfigContext', async () => {
  const actual = await import('../config/relayhall');
  return {
    useRelayHallConfig: () => ({
      config: mockConfig.current ?? actual.DEFAULT_CONFIG,
      loading: false,
      error: null,
    }),
  };
});

afterEach(() => {
  mockConfig.current = null;
  cleanup();
});

describe('login page product attribution (RH-DESIGN.6 §5.3)', () => {
  test('the fixed attribution line names RelayHall', () => {
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByText('Powered by')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'RelayHall' })).toBeInTheDocument();
    expect(screen.getByText(`v${RELAYHALL_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText('MIT licensed')).toBeInTheDocument();
  });

  test('a hostile deployment configuration cannot replace or hide it', () => {
    // The anti-impersonation floor is the point of §5.3: a deployment may set
    // its own title and subtitle, and may not use them to make the product look
    // like something else. This drives config with the attribution's own words
    // and proves the fixed line still stands on its own.
    mockConfig.current = {
      ...DEFAULT_CONFIG,
      loginTitle: 'Powered by SomethingElse',
      loginSubtitle: 'MIT licensed',
    } as RelayHallPublicConfig;

    render(<LoginPage onLoginSuccess={vi.fn()} />);

    const attribution = screen.getByText('Powered by').closest('.login-attribution')!;
    expect(attribution).toBeInTheDocument();
    expect(within(attribution as HTMLElement).getByRole('img', { name: 'RelayHall' }))
      .toBeInTheDocument();
    // The deployment's strings render where they belong, not in place of ours.
    expect(screen.getByText('Powered by SomethingElse')).toHaveClass('login-title');
  });

  test('the licence and source are real links in every build', () => {
    // E504: the public repository exists, so there is no private presentation
    // left to fall back to. Tests run with no build flag set, which used to
    // render both as plain text.
    const { container } = render(<LoginPage onLoginSuccess={vi.fn()} />);
    const licence = screen.getByRole('link', { name: 'MIT licensed' });
    const source = screen.getByRole('link', { name: 'Source' });
    expect(licence).toHaveAttribute('href', 'https://github.com/relayhall/relayhall/blob/main/LICENSE');
    expect(source).toHaveAttribute('href', 'https://github.com/relayhall/relayhall');
    for (const link of [licence, source]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer']);
    }
    expect(container.querySelectorAll('.login-attribution-links a')).toHaveLength(2);
    expect(screen.queryByText('Private working repo')).toBeNull();
  });
});
