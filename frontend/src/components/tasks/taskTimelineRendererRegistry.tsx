import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity, Bot, CheckCircle2, CircleDot, FileCheck2, FileText, Flag,
  Handshake, History, Link2, MessageSquareText, PauseCircle, PlayCircle,
  RefreshCw, ShieldAlert, UserMinus, UserPlus,
} from 'lucide-react';
import type { TimelineEvent } from './TaskTimeline';

export interface TimelineRendererDescriptor {
  icon: LucideIcon;
  className: string;
  renderDetail: (event: TimelineEvent) => ReactNode;
}

function plainValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function eventContent(event: TimelineEvent): string {
  const parts = [event.description, Object.keys(event.metadata || {}).length ? plainValue(event.metadata) : ''].filter(Boolean);
  return parts.join('\n');
}

function QuotedContent({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <blockquote className="task-timeline-quoted-content">
    <span>{label}</span>
    <pre>{`—— BEGIN QUOTED CONTENT ——\n${value}\n—— END QUOTED CONTENT ——`}</pre>
  </blockquote>;
}

const detail = (label: string) => (event: TimelineEvent) => (
  <QuotedContent label={label} value={eventContent(event)} />
);

const renderer = (icon: LucideIcon, className: string, label: string): TimelineRendererDescriptor => ({
  icon, className, renderDetail: detail(label),
});

// D9: v1 is deliberately static and enumerated. A future event type is never
// guessed into a class; it falls through to the inert generic renderer.
export const TIMELINE_RENDERER_REGISTRY: Readonly<Record<string, TimelineRendererDescriptor>> = {
  'task.created': renderer(CircleDot, 'task-created', 'Task creation detail'),
  'task.status_changed': renderer(RefreshCw, 'task-status', 'Status change detail'),
  'task.priority_changed': renderer(Flag, 'task-priority', 'Priority change detail'),
  'task.notes_updated': renderer(MessageSquareText, 'task-notes', 'Notes update detail'),
  'task.field_changed': renderer(History, 'task-field', 'Field change detail'),
  'task.arm': renderer(PlayCircle, 'task-arm', 'Arm detail'),
  'task.park': renderer(PauseCircle, 'task-park', 'Park detail'),
  'task.claimed': renderer(UserPlus, 'task-claimed', 'Claim detail'),
  'task.released': renderer(UserMinus, 'task-released', 'Release detail'),
  'task.transitioned': renderer(RefreshCw, 'task-transitioned', 'Transition detail'),
  'handover.note': renderer(MessageSquareText, 'handover-note', 'Authored note detail'),
  'handover.finish': renderer(Handshake, 'handover-finish', 'Handover detail'),
  'report.created': renderer(FileText, 'report-created', 'Report creation detail'),
  'report.linked': renderer(Link2, 'report-linked', 'Report link detail'),
  'report.auto_promoted': renderer(FileCheck2, 'report-promoted', 'Report promotion detail'),
  'review.running': renderer(Activity, 'review-running', 'Verifier run detail'),
  'review.pass': renderer(CheckCircle2, 'review-pass', 'Verifier decision detail'),
  'review.reject': renderer(ShieldAlert, 'review-reject', 'Verifier decision detail'),
  'review.escalate': renderer(ShieldAlert, 'review-escalate', 'Verifier escalation detail'),
  'review.unknown': renderer(FileCheck2, 'review-unknown', 'Verifier detail'),
  'outpost.progress': renderer(Activity, 'outpost-progress', 'Outpost progress detail'),
  'outpost.reported': renderer(FileText, 'outpost-reported', 'Outpost report detail'),
  'outpost.safety': renderer(ShieldAlert, 'outpost-safety', 'Outpost safety detail'),
  'session.started': renderer(Bot, 'session-started', 'Agent session detail'),
  'session.steered': renderer(Bot, 'session-steered', 'Agent session detail'),
  'session.cancelled': renderer(Bot, 'session-cancelled', 'Agent session detail'),
  'session.finished': renderer(Bot, 'session-finished', 'Agent session detail'),
  'session.reference': renderer(History, 'session-reference', 'Legacy session detail'),
  'telemetry.progress': renderer(Activity, 'telemetry-progress', 'Telemetry detail'),
  'progress.updated': renderer(Activity, 'progress-updated', 'Progress detail'),
  'safety.signal': renderer(ShieldAlert, 'safety-signal', 'Safety signal detail'),
};

export const GENERIC_TIMELINE_RENDERER: TimelineRendererDescriptor = {
  icon: Activity,
  className: 'generic',
  renderDetail: event => <QuotedContent
    label={`${event.provenance || event.source || 'unattributed'} provenance`}
    value={eventContent(event) || event.title}
  />,
};

export function timelineRendererFor(event: TimelineEvent): TimelineRendererDescriptor {
  return TIMELINE_RENDERER_REGISTRY[event.eventType] || GENERIC_TIMELINE_RENDERER;
}
