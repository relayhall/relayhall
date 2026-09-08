// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { BreakGlassBanner } from './BreakGlassBanner';

/**
 * THE BREAK-GLASS ANNOUNCEMENT (owner ruling `60307311` §1.1).
 *
 * The property that matters is the CONJUNCTION: it says something only when
 * this session came through the password door AND the deployment has an
 * ordinary administrator. A banner that fired on the first half alone would
 * scold every bootstrapping deployment for using the only door it has, and a
 * banner that never fired would be the silence the ruling ends.
 */
const usedBreakGlass = vi.hoisted(() => vi.fn());
vi.mock('../utils/auth', () => ({ auth: { usedBreakGlass } }));

afterEach(() => { usedBreakGlass.mockReset(); cleanup(); });

describe('the banner', () => {
  test('says so when the marker is armed', () => {
    usedBreakGlass.mockReturnValue(true);
    render(<BreakGlassBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('break-glass');
    expect(banner).toHaveTextContent('audit ledger');
  });

  test('renders nothing at all when it is not', () => {
    usedBreakGlass.mockReturnValue(false);
    const { container } = render(<BreakGlassBanner />);
    // Not merely hidden: an empty render is what keeps the banner out of the
    // accessibility tree and out of the page's flow.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('can be dismissed for this visit', () => {
    usedBreakGlass.mockReturnValue(true);
    render(<BreakGlassBanner />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('the dismiss control is named for a screen reader, not only drawn', () => {
    usedBreakGlass.mockReturnValue(true);
    render(<BreakGlassBanner />);
    expect(screen.getByRole('button', { name: 'Dismiss the break-glass notice' })).toBeInTheDocument();
  });

  test('it is a status, not an alert — nothing has failed', () => {
    usedBreakGlass.mockReturnValue(true);
    render(<BreakGlassBanner />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
