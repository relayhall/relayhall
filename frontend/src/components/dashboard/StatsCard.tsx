import React from 'react';
import { Link } from 'react-router-dom';
import './StatsCard.css';
import type { LucideIcon } from 'lucide-react';

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  trend?: string;
  description?: string;
  color: 'blue' | 'orange' | 'green' | 'purple' | 'yellow' | 'red' | 'gray';
  pulse?: boolean;
  to?: string;
}

export const StatsCard: React.FC<StatsCardProps> = ({
  icon: Icon,
  label,
  value,
  trend,
  description,
  color,
  pulse = false,
  to,
}) => {
  const content = (
    <>
      <div className="stats-card-icon"><Icon size={20} aria-hidden="true" /></div>
      
      <div className="stats-card-content">
        <div className="stats-card-label">{label}</div>
        <div className="stats-card-value">{value}</div>
        
        {trend && (
          <div className="stats-card-trend">{trend}</div>
        )}
        
        {description && (
          <div className="stats-card-description">{description}</div>
        )}
      </div>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={`stats-card stats-card-${color} ${pulse ? 'stats-card-pulse' : ''} stats-card-link`}>
        {content}
      </Link>
    );
  }

  return (
    <div className={`stats-card stats-card-${color} ${pulse ? 'stats-card-pulse' : ''}`}>
      {content}
    </div>
  );
};
