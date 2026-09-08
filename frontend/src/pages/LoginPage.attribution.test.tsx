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

  test('a private build links nowhere at all', () => {
    // Publication is an owner gate (b547f64e / c2885bbd) and the flag defaults
    // to private, so an unset build argument must never produce a public link.
    // Tests run without VITE_PUBLIC_BUILD, which is exactly the default case.
    const { container } = render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('Private working repo')).toBeInTheDocument();
  });
});
