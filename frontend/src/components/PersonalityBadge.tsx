import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { getPersonalityColor } from '../types/personality';
import './PersonalityBadge.css';

interface PersonalityBadgeProps {
  personality: {
    id: string;
    slug?: string | null;
    name: string;
    color?: string | null;
    category?: string | null;
  } | null | undefined;
  /** If true, clicking navigates to the personality detail page */
  clickable?: boolean;
  size?: 'sm' | 'md';
}

export const PersonalityBadge: React.FC<PersonalityBadgeProps> = ({
  personality,
  clickable = true,
  size = 'sm',
}) => {
  const navigate = useNavigate();

  if (!personality) return null;

  const color = getPersonalityColor(personality.color ?? null);

  const handleClick = (e: React.MouseEvent) => {
    if (!clickable) return;
    e.stopPropagation();
    e.preventDefault();
    navigate(`/personalities/${personality.id}`);
  };

  return (
    <span
      className={`personality-badge personality-badge--${size} ${clickable ? 'personality-badge--clickable' : ''}`}
      style={{ '--badge-color': color } as React.CSSProperties}
      onClick={handleClick}
      title={`Personality: ${personality.name}${personality.category ? ` (${personality.category})` : ''}`}
    >
      <Bot size={size === 'sm' ? 10 : 13} />
      <span className="badge-label">{personality.name}</span>
    </span>
  );
};
