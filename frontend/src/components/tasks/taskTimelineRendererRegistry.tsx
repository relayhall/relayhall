import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity, Bot, CheckCircle2, CircleDot, FileCheck2, FileText, Flag,
  Handshake, History, Link2, MessageSquareText, PauseCircle, PlayCircle,
  RefreshCw, ShieldAlert, ShieldOff, UserMinus, UserPlus,
} from 'lucide-react';
import type { TimelineEvent } from './TaskTimeline';
import { TASK_STATUS_OPTIONS } from './taskFieldEditors';

export interface TimelineRendererDescriptor {
  icon: LucideIcon;
  className: string;
  renderDetail: (event: TimelineEvent) => ReactNode;
}

// E387(2): an expanded event reads as plain words. Everything below renders
// through React text, never as HTML: the visual BEGIN/END fence retired, the
// untrusted-data property it stood for did not. Board text stays inert text.

/** Field labels for the history rows the server maps (UnifiedTaskTimeline
 *  historyTitle); any other field falls back to a sentence-cased name. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  status: 'Status',
  priority: 'Priority',
  notes: 'Notes',
  autoStart: 'Armed',
  created: 'Created',
  title: 'Title',
  description: 'Description',
  project: 'Project',
  phaseId: 'Phase',
  tags: 'Tags',
  dueAt: 'Due',
  assignee: 'Assignee',
  ownerPrincipalId: 'Assignee',
  shepherdPrincipalId: 'Shepherd',
  verifierPrincipalId: 'Verifier',
  trackerUrl: 'Tracker URL',
  discordThreadId: 'Discord thread',
};

const EMPTY_VALUE = '—';

/** `attemptCount` → "Attempt count", `status_before` → "Status before". */
export function sentenceCaseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.:-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/** A value as plain words: no JSON punctuation, nested values as
 *  "Key: value" pairs joined by "; ", lists joined by ", ". */
export function plainText(value: unknown, depth = 0): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.map(item => plainText(item, depth + 1)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, plainText(item, depth + 1)] as const)
      .filter(([, text]) => text !== '')
      .map(([key, text]) => `${sentenceCaseKey(key)}: ${text}`)
      .join('; ');
  }
  return String(value);
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? sentenceCaseKey(field);
}

function fieldValue(field: string, value: unknown): string {
  const text = plainText(value);
  if (!text) return EMPTY_VALUE;
  if (field === 'status') return TASK_STATUS_OPTIONS.find(option => option.value === text)?.label ?? text;
  if (field === 'priority') return text[0].toUpperCase() + text.slice(1);
  if (field === 'autoStart') return text === 'true' ? 'Yes' : text === 'false' ? 'No' : text;
  return text;
}

const CHANGE_KEYS = new Set(['field', 'oldValue', 'newValue']);

function Facts({ entries }: { entries: Array<[string, unknown]> }) {
  const rows = entries
    .map(([key, value]) => [key, plainText(value)] as const)
    .filter(([, text]) => text !== '');
  if (!rows.length) return null;
  return <dl className="task-timeline-facts">
    {rows.map(([key, text]) => <div key={key}><dt>{sentenceCaseKey(key)}</dt><dd>{text}</dd></div>)}
  </dl>;
}

function ChangeLine({ metadata }: { metadata: Record<string, unknown> }) {
  const field = String(metadata.field);
  if (field === 'notes') {
    const before = plainText(metadata.oldValue);
    const after = plainText(metadata.newValue);
    return <>
      <p className="task-timeline-change">Notes were updated.</p>
      {before || after ? <dl className="task-timeline-facts">
        <div><dt>Before</dt><dd>{before || EMPTY_VALUE}</dd></div>
        <div><dt>After</dt><dd>{after || EMPTY_VALUE}</dd></div>
      </dl> : null}
    </>;
  }
  return <p className="task-timeline-change">
    <strong>{fieldLabel(field)}:</strong> {fieldValue(field, metadata.oldValue)} → {fieldValue(field, metadata.newValue)}
  </p>;
}

const PROVENANCE_WORDS: Readonly<Record<string, string>> = {
  authored: 'authored board text',
  reported: 'reported board text',
  legacy: 'legacy board text',
};

/** Board text (notes, handovers, reports): a quiet note block, plain text,
 *  wrapping as written. The caption keeps the provenance label. */
function BoardText({ label, provenance, text }: { label: string; provenance: string; text: string }) {
  return <blockquote className="task-timeline-quoted-content">
    <span className="task-timeline-quote-label"><span>{label}</span>{PROVENANCE_WORDS[provenance] ? <span>{` · ${PROVENANCE_WORDS[provenance]}`}</span> : null}</span>
    <p>{text}</p>
  </blockquote>;
}

/** One detail renderer for every event type: a plain-words change line for a
 *  field change, the event's own text (board text for authored or reported
 *  events), then any other metadata as a compact key: value list. */
export function EventDetail({ event, label }: { event: TimelineEvent; label: string }) {
  const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const isChange = typeof metadata.field === 'string' && metadata.field !== '';
  const rest = Object.entries(metadata).filter(([key]) => !(isChange && CHANGE_KEYS.has(key)));
  const description = event.description ?? '';
  const system = event.provenance === 'system' || !event.provenance;
  const facts = <Facts entries={rest} />;
  const hasFacts = rest.some(([, value]) => plainText(value) !== '');
  return <>
    {isChange ? <ChangeLine metadata={metadata} /> : null}
    {description
      ? system
        ? <p className="task-timeline-detail-text">{description}</p>
        : <BoardText label={label} provenance={event.provenance} text={description} />
      : null}
    {facts}
    {!isChange && !description && !hasFacts
      ? <p className="task-timeline-detail-text">No further detail was recorded.</p>
      : null}
  </>;
}

const renderer = (icon: LucideIcon, className: string, label: string): TimelineRendererDescriptor => ({
  icon, className, renderDetail: event => <EventDetail event={event} label={label} />,
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
  // Owner ruling E462 S4b: verification none set or cleared.
  'task.verification_mode': renderer(ShieldOff, 'task-verification-mode', 'Verification mode detail'),
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
  renderDetail: event => <EventDetail
    event={event}
    label={`${sentenceCaseKey(event.provenance || event.source || 'unattributed')} provenance`}
  />,
};

export function timelineRendererFor(event: TimelineEvent): TimelineRendererDescriptor {
  return TIMELINE_RENDERER_REGISTRY[event.eventType] || GENERIC_TIMELINE_RENDERER;
}
