// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { Wordmark } from './Wordmark';
import { WORDMARK_DESCENDER_FRACTION, WORDMARK_PATHS } from '../brand/wordmarkPaths';

afterEach(cleanup);

describe('Wordmark', () => {
  test('renders every generated outline, in order', () => {
    const { container } = render(<Wordmark />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(WORDMARK_PATHS.length);
    expect([...paths].map((path) => path.getAttribute('d'))).toEqual(
      WORDMARK_PATHS.map((path) => path.d)
    );
  });

  test('paints from semantic tokens, never from a literal', () => {
    // The reason the mark is inline at all: an <img> would freeze relay-dark's
    // values onto a paper-white page. If a fill literal ever appears here the
    // wordmark has stopped following the Theme.
    const { container } = render(<Wordmark />);
    for (const path of container.querySelectorAll('path')) {
      expect(path.getAttribute('fill')).toBeNull();
      expect(path.getAttribute('class')).toMatch(/^wordmark-(ink|accent)$/);
    }
  });

  test('splits Relay from Hall — five glyphs of ink, four of accent', () => {
    // Cut A's whole device (owner ruling 9aa295f2). A regression that painted
    // the word in one colour would still render, still pass every gate, and
    // quietly discard the selected identity.
    const roles = WORDMARK_PATHS.map((path) => path.role);
    expect(roles).toEqual([
      'ink', 'ink', 'ink', 'ink', 'ink',
      'accent', 'accent', 'accent', 'accent',
    ]);
  });

  test('names the product by default and is silent when decorative', () => {
    render(<Wordmark />);
    expect(screen.getByRole('img', { name: 'RelayHall' })).toBeInTheDocument();

    cleanup();
    const { container } = render(<Wordmark decorative />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('the mono binding is a class, so it still resolves through the Theme', () => {
    const { container } = render(<Wordmark mono />);
    expect(container.querySelector('svg')).toHaveClass('wordmark--mono');
  });

  test('sits on the text baseline rather than on its own box', () => {
    // The mark shares a line with "Powered by". An inline-block's baseline is
    // its bottom margin edge, so the descender is pulled back out of the flow;
    // without this the letterforms ride visibly above the words beside them,
    // which is how the first cut of the login attribution actually shipped.
    const { container } = render(<Wordmark height={20} />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.marginBottom).toBe(`${-20 * WORDMARK_DESCENDER_FRACTION}px`);
    expect(WORDMARK_DESCENDER_FRACTION).toBeGreaterThan(0);
    expect(WORDMARK_DESCENDER_FRACTION).toBeLessThan(0.5);
  });

  test('scales on its own proportions rather than being squashed to a box', () => {
    const { container } = render(<Wordmark height={30} />);
    const svg = container.querySelector('svg')!;
    const [, , viewWidth, viewHeight] = WORDMARK_PATHS.length
      ? svg.getAttribute('viewBox')!.split(' ').map(Number)
      : [0, 0, 0, 0];
    expect(Number(svg.getAttribute('height'))).toBe(30);
    expect(Number(svg.getAttribute('width'))).toBeCloseTo((30 * viewWidth) / viewHeight, 5);
  });
});
