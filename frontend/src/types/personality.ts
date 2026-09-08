export interface Personality {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  source: 'built-in' | 'managed' | 'git' | 'legacy-db';
  created_at: string;
  updated_at: string;
}

export interface PersonalitySummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  is_custom: boolean;
  source: 'built-in' | 'managed' | 'git' | 'legacy-db';
}

export interface PersonalityDetail extends Personality {
  linkedSessions: LinkedSession[];
  linkedTasks: LinkedTask[];
}

export interface LinkedSession {
  session_key: string;
  kind: string;
  label: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  // PostgreSQL NUMERIC values are serialized by node-postgres as strings.
  total_cost_usd: number | string | null;
  message_count: number | null;
}

export interface LinkedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  project: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Map color names to Tailwind/CSS color values */
export const PERSONALITY_COLORS: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  orange: '#f97316',
  red: '#ef4444',
  yellow: '#eab308',
  pink: '#ec4899',
  cyan: '#06b6d4',
  gray: '#6b7280',
  indigo: '#6366f1',
};

/** Owner-facing source label. Personalities are board-native; the stored
 *  'git' / 'legacy-db' values are historical imported rows (the repository
 *  sync was removed 2026-08-09) and display as imported. */
export function formatPersonalitySource(source: string): string {
  if (source === 'git') return 'imported';
  if (source === 'legacy-db') return 'imported (legacy)';
  return source;
}

export function getPersonalityColor(color: string | null): string {
  if (!color) return PERSONALITY_COLORS.gray;
  return PERSONALITY_COLORS[color] || color;
}
