import React from 'react';

/**
 * Control-kit native select (RH-UI.20, design 77950a97 §7): the shared
 * .form-select recipe (styles/forms.css) at one of the two ratified control
 * sizes. A thin wrapper — no custom popup — so every listbox in the estate
 * keeps native semantics while sharing one skin.
 */
interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'standard' | 'compact';
  children: React.ReactNode;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ size = 'compact', className = '', children, ...rest }, ref) => (
    <select
      ref={ref}
      className={`form-select ${size === 'standard' ? 'form-select-standard' : ''} ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
);

Select.displayName = 'Select';
