import React from 'react';
import './StatusOrb.css';

interface StatusOrbProps {
  state: string;
  size: number;
}

/**
 * Simple animated status orb indicator.
 * Replaces the WebGL Orb for lightweight deployments.
 */
export const StatusOrb: React.FC<StatusOrbProps> = ({ state, size }) => {
  const stateClass = ['thinking', 'typing', 'tool-use', 'busy', 'waiting'].includes(state)
    ? 'active'
    : state === 'error'
      ? 'error'
      : 'idle';

  return (
    <div
      className={`status-orb status-orb--${stateClass}`}
      style={{ width: size, height: size }}
    >
      <div className="status-orb-inner" />
      <div className="status-orb-ring" />
      {stateClass === 'active' && <div className="status-orb-pulse" />}
    </div>
  );
};
