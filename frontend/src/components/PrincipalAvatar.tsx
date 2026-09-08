import React from 'react';
import { User, Bot, Cog } from 'lucide-react';
import type { Principal, PrincipalKind } from '../types/task';
import './PrincipalAvatar.css';

interface PrincipalAvatarProps {
  /** Resolved principal. Null/undefined renders the fallback (or nothing). */
  principal?: Principal | null;
  /**
   * Display text for identities with no principal row — historical activity,
   * or anything created before the substrate landed. Rendered in a muted
   * "unattributed" style so it reads as provenance we never had, not as a
   * principal we resolved.
   */
  fallbackLabel?: string | null;
  size?: 'sm' | 'md';
  /** Show the label beside the icon. Off = icon only (dense lanes). */
  showLabel?: boolean;
  /**
   * Render the handle rather than the display name. Surfaces that let you
   * filter or search BY handle should show the handle, or the two halves of
   * the UI disagree about what an identity is called.
   */
  preferHandle?: boolean;
}

const KIND_ICON: Record<PrincipalKind, typeof User> = {
  human: User,
  agent: Bot,
  service: Cog,
};

/**
 * Twelve hues, 30 degrees apart. Any two entries are far enough apart to read
 * as different colours at chip size on the dark theme.
 */
export const PRINCIPAL_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

/**
 * Deterministic hue from the handle, so an identity keeps the same colour
 * across every surface and across reloads without storing anything.
 *
 * Quantised to a fixed palette rather than mapped onto the full wheel. A
 * continuous hash — with or without a golden-angle step, which decorrelates
 * sequential indices and does nothing for values that are already random —
 * put several of the real handles within a few degrees of each other, which
 * renders as the same colour while implying they are different. With a
 * palette, two identities either look clearly distinct or exactly alike;
 * "nearly the same" is the only genuinely misleading outcome, and it cannot
 * happen. Collisions are unavoidable anyway: identities are unbounded.
 */
export function hueForHandle(handle: string): number {
  let hash = 2166136261;
  for (let i = 0; i < handle.length; i++) {
    hash ^= handle.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PRINCIPAL_HUES[(hash >>> 0) % PRINCIPAL_HUES.length];
}

export const PrincipalAvatar: React.FC<PrincipalAvatarProps> = ({
  principal,
  fallbackLabel,
  size = 'sm',
  showLabel = true,
  preferHandle = false,
}) => {
  if (!principal) {
    if (!fallbackLabel) return null;
    return (
      <span
        className={`principal-avatar principal-avatar--${size} principal-avatar--unattributed`}
        title={`${fallbackLabel} — no principal recorded (predates identity attribution)`}
      >
        <Bot size={size === 'sm' ? 11 : 14} />
        {showLabel && <span className="principal-avatar__label">{fallbackLabel}</span>}
      </span>
    );
  }

  const Icon = KIND_ICON[principal.kind] ?? Bot;
  const label = preferHandle
    ? principal.handle
    : (principal.displayName || principal.handle);
  const disabled = principal.status === 'disabled';
  const tooltip = [
    principal.handle,
    principal.role ? `role: ${principal.role}` : null,
    principal.harness ? `harness: ${principal.harness}` : null,
    disabled ? 'DISABLED' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      className={`principal-avatar principal-avatar--${size} principal-avatar--${principal.kind}${disabled ? ' principal-avatar--disabled' : ''}`}
      style={{ '--principal-hue': hueForHandle(principal.handle) } as React.CSSProperties}
      title={tooltip}
    >
      <Icon size={size === 'sm' ? 11 : 14} />
      {showLabel && <span className="principal-avatar__label">{label}</span>}
    </span>
  );
};
