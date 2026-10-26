import React from 'react';
import {
  AlertTriangle, ArrowRight, BookOpen, FileText, Folder, Gavel, KeyRound, Layers, ListTodo, Pencil, ShieldCheck,
} from 'lucide-react';
import type { ActionGroupKind } from './notifications';
import type { TimelineType } from './timeline';

/**
 * An action item's or a Timeline row's icon: what KIND of thing it is (card
 * 5854f0d6, Slice B). Decorative — every row also says it in words — so every
 * caller hides it from assistive technology.
 */
export const ActionIcon: React.FC<{ kind: ActionGroupKind }> = ({ kind }) => {
  if (kind === 'decision') return <Gavel size={16} />;
  if (kind === 'verify') return <ShieldCheck size={16} />;
  if (kind === 'stuck') return <AlertTriangle size={16} />;
  if (kind === 'skill') return <BookOpen size={16} />;
  return <ListTodo size={16} />;
};

export const TimelineIcon: React.FC<{ kind: TimelineType }> = ({ kind }) => {
  switch (kind) {
    case 'status': return <ArrowRight size={16} />;
    case 'update': return <Pencil size={16} />;
    case 'stuck': return <AlertTriangle size={16} />;
    case 'review': return <ShieldCheck size={16} />;
    case 'report': return <FileText size={16} />;
    case 'phase': return <Layers size={16} />;
    case 'project': return <Folder size={16} />;
    case 'skill':
    case 'skill-version': return <BookOpen size={16} />;
    case 'approval': return <Gavel size={16} />;
    case 'access': return <KeyRound size={16} />;
    default: return <ListTodo size={16} />;
  }
};
