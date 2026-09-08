import React from 'react';
import {
  WORDMARK_DESCENDER_FRACTION,
  WORDMARK_PATHS,
  WORDMARK_VIEW_BOX,
} from '../brand/wordmarkPaths';
import './Wordmark.css';

interface WordmarkProps {
  /** Rendered height in pixels. Width follows the mark's own proportions. */
  height?: number;
  /**
   * One ink instead of two. The monochrome binding (D16) — for anywhere the
   * accent cannot be trusted, and for surfaces that already carry the accent.
   */
  mono?: boolean;
  /**
   * Paint the recessive ink (`--text-tertiary`) instead of the primary one, for
   * a line that identifies the software without asking to be read. A token
   * rather than an opacity, so high-contrast stays high-contrast.
   */
  quiet?: boolean;
  /**
   * Decorative when the same words are already in the accessible name of the
   * thing this sits inside; otherwise the mark names the product itself.
   */
  decorative?: boolean;
  className?: string;
}

/**
 * The RelayHall wordmark, inline (RH-UI.3; owner ruling 9aa295f2 — Cut A).
 *
 * Inline rather than an `<img src="wordmark.svg">` because the mark follows the
 * active Theme: "Relay" paints `--text-primary` and "Hall" paints
 * `--accent-color`, and an external SVG resolves neither — it would freeze the
 * relay-dark values onto a paper-white page. The outlines come from
 * `brand/wordmarkPaths.ts`, generated from the same IBM Plex woff2 the product
 * serves; the standalone `.svg` files exist for the contexts that need a file.
 *
 * This is fixed product attribution (§5.3): it is not reachable by deployment
 * configuration, and no Appearance field feeds it.
 */
export const Wordmark: React.FC<WordmarkProps> = ({
  height = 16,
  mono = false,
  quiet = false,
  decorative = false,
  className,
}) => {
  const [, , width, viewHeight] = WORDMARK_VIEW_BOX.split(' ').map(Number);
  const accessibility = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': 'RelayHall' } as const);

  // An inline-block's baseline is its bottom MARGIN edge, so pulling that edge
  // up by exactly the descender puts the mark's own baseline on the text
  // baseline beside it. Centring the box instead centres the empty descender
  // space and lifts the letterforms visibly off the line.
  const descender = height * WORDMARK_DESCENDER_FRACTION;

  return (
    <svg
      className={[
        'wordmark',
        mono ? 'wordmark--mono' : '',
        quiet ? 'wordmark--quiet' : '',
        className || '',
      ].filter(Boolean).join(' ')}
      viewBox={WORDMARK_VIEW_BOX}
      height={height}
      width={(height * width) / viewHeight}
      style={{ marginBottom: `${-descender}px` }}
      focusable="false"
      {...accessibility}
    >
      {WORDMARK_PATHS.map((path, index) => (
        <path key={index} className={`wordmark-${path.role}`} d={path.d} />
      ))}
    </svg>
  );
};
