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
  /* Unavailable for now but still focusable: `aria-disabled` instead of
     `disabled`, so keyboard focus is not thrown off a control that is only
     busy (card 5854f0d6 review). The caller's onClick must return early
     while it is set: the button still receives clicks. */
  ariaDisabled?: boolean;
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
  /* The id of the text that explains this control, such as why it is
     disabled. A hyphenated `aria-describedby` on this component type-checks
     and is silently dropped, because nothing is spread (card 3fc32dd1). */
  ariaDescribedBy?: string;
  /* Reaches the rendered element as `data-testid`. Kept explicit rather than
     spreading arbitrary props: a control kit that forwards anything stops
     being a contract (task 482e21fa). */
  dataTestId?: string;
  /* E469: opt in to the phone long-press / focus label (ui/LabelTip.tsx), for a
     button whose words are visually hidden on a phone. Inert unless the button
     sits in a row that calls useLabelTips. */
  labelTip?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  variant = 'primary',
  size = 'standard',
  icon,
  disabled = false,
  ariaDisabled,
  className = '',
  type = 'button',
  title,
  ariaLabel,
  ariaPressed,
  ariaExpanded,
  ariaControls,
  ariaHaspopup,
  ariaDescribedBy,
  dataTestId,
  labelTip = false
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      className={`btn btn-${variant} ${size === 'compact' ? 'btn-compact' : ''} ${className}`}
      type={type}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-haspopup={ariaHaspopup}
      aria-describedby={ariaDescribedBy}
      data-testid={dataTestId}
      data-label-tip={labelTip ? '' : undefined}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span className="btn-text">{children}</span>
    </button>
  );
};
