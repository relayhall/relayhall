import React, { useCallback, useLayoutEffect, useRef } from 'react';
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
 *
 * Tabs (card e2dd52b8 Part A): when the choice switches between views of one
 * page, pass `tabs` and the same recipe renders as an APG tablist instead —
 * role tablist / tab with `aria-selected`, each tab's id from `tabs.tabId`, and
 * `aria-controls` on the SELECTED tab only (the host mounts the active panel
 * alone, so a reference to an absent panel would dangle). Activation stays
 * automatic: ArrowLeft/ArrowRight and Home/End move focus AND select. A
 * horizontal tablist leaves ArrowUp/ArrowDown to the page, so they never
 * swallow its scroll. The host renders the panel (`role="tabpanel"`, id
 * `tabs.panelId(value)`, labelled by the tab).
 *
 * Width (E461): the control never grows wider than its column. When its options
 * do not fit (five tabs on a phone) the control itself scrolls sideways, the
 * options keep their natural width, and the SELECTED option is scrolled into
 * view on mount and on every change. That scroll is horizontal only
 * (`scrollSelectedIntoView`): it moves the control's own scroll position and
 * never an ancestor, so the page does not jump vertically and nothing outside
 * the control scrolls sideways.
 */
export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
  /** Accessible name when the visible label is not plain text. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Tooltip (title) — e.g. "coming with the Map view" on a disabled entry. */
  title?: string;
  /** E469: opt this option in to the phone long-press / focus label (ui/LabelTip.tsx). */
  labelTip?: boolean;
}

interface SegmentedControlProps<V extends string> {
  options: Array<SegmentedOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  className?: string;
  /** Render as a tablist that switches the host's panels (see above). */
  tabs?: SegmentedTabs<V>;
}

/** The ids a tablist needs: each tab's own, and the panel each one controls. */
export interface SegmentedTabs<V extends string> {
  tabId: (value: V) => string;
  panelId: (value: V) => string;
}

/** Edge distance kept between the selected option and the control's own edge. */
const SCROLL_EDGE_PX = 8;

/**
 * Bring the selected option fully inside the control's own horizontal scroll
 * port. Pure horizontal: it assigns `scrollLeft` on the control and calls
 * nothing that scrolls an ancestor (`scrollIntoView` can move the page).
 * Exported for the unit test.
 */
export function scrollSelectedIntoView(group: HTMLElement): void {
  const selected = group.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]');
  if (!selected) return;
  const port = group.getBoundingClientRect();
  const item = selected.getBoundingClientRect();
  let delta = 0;
  if (item.left < port.left + SCROLL_EDGE_PX) delta = item.left - port.left - SCROLL_EDGE_PX;
  else if (item.right > port.right - SCROLL_EDGE_PX) delta = item.right - port.right + SCROLL_EDGE_PX;
  if (delta !== 0) group.scrollLeft += delta;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
  tabs
}: SegmentedControlProps<V>) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  const enabled = options.filter(o => !o.disabled);
  // The roving tab stop must survive a selection that is unknown or
  // disabled (adversarial pre-review F9/F10): it falls back to the first
  // enabled option so the group never leaves the tab order.
  const selectedEnabled = enabled.some(o => o.value === value);
  const tabStopValue = selectedEnabled ? value : enabled[0]?.value;
  const asTabs = tabs !== undefined;

  // Keep the selected option in view when it changes (a click, an arrow key, a
  // link that opens on another tab) and when the control first mounts.
  useLayoutEffect(() => {
    if (groupRef.current) scrollSelectedIntoView(groupRef.current);
  }, [value, options.length]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = asTabs
        ? ['ArrowLeft', 'ArrowRight', 'Home', 'End']
        : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
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
    [asTabs, enabled, onChange, value]
  );

  return (
    <div
      ref={groupRef}
      role={asTabs ? 'tablist' : 'radiogroup'}
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
            role={asTabs ? 'tab' : 'radio'}
            aria-checked={asTabs ? undefined : selected}
            aria-selected={asTabs ? selected : undefined}
            id={tabs?.tabId(option.value)}
            aria-controls={tabs && selected ? tabs.panelId(option.value) : undefined}
            aria-label={option.ariaLabel}
            title={option.title}
            data-label-tip={option.labelTip ? '' : undefined}
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
