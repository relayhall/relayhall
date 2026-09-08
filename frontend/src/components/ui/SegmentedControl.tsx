import React, { useCallback, useRef } from 'react';
import './SegmentedControl.css';

/**
 * THE segmented-control recipe (RH-UI.20, design 77950a97 §7).
 *
 * One recipe estate-wide: the Board|Map view switcher is the reference and
 * every other segmented choice (timeline filter, future map organization
 * switch) renders through this component. Shell radius 10, item radius 8,
 * items at the 36px compact control size, body-scale type.
 *
 * Semantics: a radiogroup with roving tabindex — Arrow keys move AND select
 * (APG radio pattern), Home/End jump to the ends. The selected option is the
 * only tab stop.
 */
export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
  /** Accessible name when the visible label is not plain text. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Tooltip (title) — e.g. "coming with the Map view" on a disabled entry. */
  title?: string;
}

interface SegmentedControlProps<V extends string> {
  options: Array<SegmentedOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = ''
}: SegmentedControlProps<V>) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  const enabled = options.filter(o => !o.disabled);
  // The roving tab stop must survive a selection that is unknown or
  // disabled (adversarial pre-review F9/F10): it falls back to the first
  // enabled option so the group never leaves the tab order.
  const selectedEnabled = enabled.some(o => o.value === value);
  const tabStopValue = selectedEnabled ? value : enabled[0]?.value;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (enabled.length === 0) return;
      const currentIndex = enabled.findIndex(o => o.value === value);
      let nextIndex: number;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = enabled.length - 1;
      else if (currentIndex === -1) {
        // Disabled/unknown selection (pre-review F12): both directions
        // land on the nearest end rather than skipping an option.
        nextIndex = (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
          ? enabled.length - 1 : 0;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
      } else {
        nextIndex = (currentIndex + 1) % enabled.length;
      }
      const next = enabled[nextIndex];
      if (next.value !== value) onChange(next.value);
      const group = groupRef.current;
      if (group) {
        // CSS.escape (pre-review F14): a value with selector-special
        // characters must not break or misdirect the focus move.
        const button = group.querySelector<HTMLButtonElement>(
          `[data-segment-value="${CSS.escape(next.value)}"]`);
        button?.focus();
      }
    },
    [enabled, onChange, value]
  );

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={`segmented-control ${className}`}
      onKeyDown={handleKeyDown}
    >
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            title={option.title}
            disabled={option.disabled}
            data-segment-value={option.value}
            tabIndex={option.value === tabStopValue && !option.disabled ? 0 : -1}
            className={`segmented-option ${selected ? 'segmented-option--selected' : ''}`}
            onClick={() => { if (!selected) onChange(option.value); }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
