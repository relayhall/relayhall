// TaskCardMoveMenu.tsx — the C2 move menu (ratified design 3cdf6e65 §2.2).
// APG menu-button pattern, mounted OUTSIDE the handle button as a SIBLING in
// the card's tree (a menu nested inside its trigger button would recreate
// the nested-interactive violation the a7df1af repair removed; a body portal
// would fall outside every landmark — axe region). position:fixed escapes
// the card's overflow clipping without a portal. One mechanism at every
// breakpoint: this replaces the bespoke mobile "Move" flow, and it is the
// pointer alternative to drag (drag is never the only pointer path).
import React, { useEffect, useRef } from 'react';
import type { TaskStatus } from '../../types/task';

/** Ratified state labels (b94dd86e; enumerated in the design contract §2.2). */
export const MOVE_STATE_LABELS: Record<string, string> = {
  ideas: 'Ideas',
  todo: 'Todo',
  'in-progress': 'In progress',
  review: 'Review',
  stuck: 'Stuck',
  completed: 'Completed',
};

const NON_ARCHIVED_STATES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed'] as const;

export interface TaskCardMoveMenuProps {
  taskTitle: string;
  currentStatus: TaskStatus | string;
  /** Archive appears only where the board currently offers it (parity). */
  archiveAvailable: boolean;
  anchor: { x: number; y: number };
  onSelect: (targetStatus: string) => void;
  onArchive: () => void;
  onClose: () => void;
}

export const TaskCardMoveMenu: React.FC<TaskCardMoveMenuProps> = ({
  taskTitle,
  currentStatus,
  archiveAvailable,
  anchor,
  onSelect,
  onArchive,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const isArchived = currentStatus === 'archived';

  const items: Array<{ key: string; label: string; action: () => void; disabled: boolean }> =
    NON_ARCHIVED_STATES.map((state) => ({
      key: state,
      // Archived tasks list the six non-archived states as "Unarchive to …"
      // (ratified verb — never "Restore").
      label: isArchived ? `Unarchive to ${MOVE_STATE_LABELS[state]}` : MOVE_STATE_LABELS[state],
      action: () => onSelect(state),
      disabled: !isArchived && state === currentStatus,
    }));
  if (archiveAvailable && !isArchived) {
    items.push({ key: 'archived', label: 'Archive', action: onArchive, disabled: false });
  }

  useEffect(() => {
    // focus the first enabled item on open (APG menu pattern)
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
  }, []);

  // Arrow keys act inside the menu and never leak to the board's roving
  // handler; Escape closes and the trigger restores focus (handled by the
  // caller through onClose).
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    const enabled = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        event.preventDefault();
        enabled[(index + 1) % enabled.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        enabled[(index - 1 + enabled.length) % enabled.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        enabled[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        enabled[enabled.length - 1]?.focus();
        break;
      case 'Tab':
        // a menu is modal to the tab order; close instead of tabbing through
        event.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="task-card-move-menu"
      role="menu"
      aria-label={`Move task: ${taskTitle}`}
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className="task-card-move-menu-item"
          aria-disabled={item.disabled ? 'true' : undefined}
          disabled={item.disabled}
          tabIndex={-1}
          onClick={() => { if (!item.disabled) item.action(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};
