import React from 'react';
import './IconButton.css';

/**
 * Control-kit icon-only button (RH-UI.20, design 77950a97 §7): a square
 * control at one of the two ratified sizes with a MANDATORY accessible
 * name. Icons ride the 16/20/24 grid (existing iconography gate).
 */
interface IconButtonProps {
  icon: React.ReactNode;
  ariaLabel: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  size?: 'standard' | 'compact';
  variant?: 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  /** Tooltip; defaults to the accessible name so sighted users get it too. */
  title?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  /* The region this control discloses. Dropping it on a conversion silently
     weakens the APG disclosure pattern (task 482e21fa). */
  ariaControls?: string;
  ariaHaspopup?: React.AriaAttributes['aria-haspopup'];
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(({
  icon,
  ariaLabel,
  onClick,
  size = 'compact',
  variant = 'secondary',
  disabled = false,
  className = '',
  title,
  ariaPressed,
  ariaExpanded,
  ariaControls,
  ariaHaspopup
}, ref) => {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-haspopup={ariaHaspopup}
      className={`icon-btn icon-btn-${variant} ${size === 'standard' ? 'icon-btn-standard' : ''} ${className}`}
    >
      {icon}
    </button>
  );
});

IconButton.displayName = 'IconButton';
