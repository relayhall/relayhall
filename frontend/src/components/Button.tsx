import React from 'react';
import './Button.css';

interface ButtonProps {
  children: React.ReactNode;
  /* Receives the event, matching IconButton. Nested controls that sit inside a
     clickable row need `stopPropagation`, and a `() => void` signature is the
     one thing that kept them hand-rolled (task 482e21fa). Widening is
     backwards-compatible: every existing zero-argument handler still fits. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  /* §7: exactly two control sizes. 'standard' (48px) for page headers and
     primary flows; 'compact' (36px) for toolbars and dense surfaces. */
  size?: 'standard' | 'compact';
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /* Explicit default: a classless <button> inside a <form> would submit it. */
  type?: 'button' | 'submit';
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  /* Disclosure state, mirroring IconButton. A toggle that reveals a region is
     `aria-expanded`, NOT `aria-pressed`; without this prop a conversion would
     have to silently swap one for the other (task 482e21fa). */
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaHaspopup?: React.AriaAttributes["aria-haspopup"];
  /* Reaches the rendered element as `data-testid`. Kept explicit rather than
     spreading arbitrary props: a control kit that forwards anything stops
     being a contract (task 482e21fa). */
  dataTestId?: string;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  variant = 'primary',
  size = 'standard',
  icon,
  disabled = false,
  className = '',
  type = 'button',
  title,
  ariaLabel,
  ariaPressed,
  ariaExpanded,
  ariaControls,
  ariaHaspopup,
  dataTestId
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`btn btn-${variant} ${size === 'compact' ? 'btn-compact' : ''} ${className}`}
      type={type}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-haspopup={ariaHaspopup}
      data-testid={dataTestId}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-text">{children}</span>
    </button>
  );
};
