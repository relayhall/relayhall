import { useId, useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import type { TaskDueAtWrite, TaskPriority, TaskStatus } from '../../types/task';
import type { PersonalitySummary } from '../../types/personality';
import { formatInstantForDateTimeLocal, formatInstantUtc } from '../../utils/dateFormat';
import { Select } from '../ui/Select';
import { IconButton } from '../ui/IconButton';

/**
 * Shared Task field editors (design 986be411 §7, candidate A5): ONE source of
 * truth for the option vocabularies and ONE control per field, consumed by
 * BOTH the routed create mode and the Task-details edit mode. Legitimate mode
 * differences (archived availability, disabled states) are parameters —
 * never a second copy of the vocabulary.
 */
export const TASK_STATUS_OPTIONS: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: 'ideas', label: 'Ideas' },
  { value: 'todo', label: 'Todo' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'stuck', label: 'Stuck' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
] as const;

export const TASK_PRIORITY_OPTIONS: readonly TaskPriority[] = ['urgent', 'high', 'normal', 'low', 'someday'] as const;

export const THINKING_LEVEL_OPTIONS: readonly string[] = ['', 'low', 'medium', 'high'] as const;

export const parseTagsInput = (value: string): string[] =>
  Array.from(new Set(value.split(',').map(tag => tag.trim()).filter(Boolean)));

export function StatusSelect({ value, onChange, disabled = false, includeArchived = true }: {
  value: TaskStatus;
  onChange: (next: TaskStatus) => void;
  disabled?: boolean;
  includeArchived?: boolean;
}) {
  const options = includeArchived ? TASK_STATUS_OPTIONS : TASK_STATUS_OPTIONS.filter(option => option.value !== 'archived');
  return (
    <Select aria-label="Status" value={value} disabled={disabled} onChange={event => onChange(event.target.value as TaskStatus)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}

export function PrioritySelect({ value, onChange, disabled = false }: {
  value: TaskPriority;
  onChange: (next: TaskPriority) => void;
  disabled?: boolean;
}) {
  return (
    <Select aria-label="Priority" value={value} disabled={disabled} onChange={event => onChange(event.target.value as TaskPriority)}>
      {TASK_PRIORITY_OPTIONS.map(option => <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}
    </Select>
  );
}

export function ProjectSelect({ projects, value, onChange }: {
  projects: ReadonlyArray<{ id: string; name: string }>;
  value: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <Select aria-label="Project" value={value} onChange={event => onChange(event.target.value)}>
      <option value="">No Project</option>
      {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </Select>
  );
}

export function TagsInput({ id, value, onChange }: {
  id?: string;
  value: string;
  onChange: (raw: string) => void;
}) {
  return <input id={id} aria-label="Tags" value={value} placeholder="comma, separated" onChange={event => onChange(event.target.value)} />;
}

/**
 * The Task deadline (card 7d38a6e0), as ONE control shared by the create page
 * and the Task details page — the §7 rule this module exists for.
 *
 * `datetime-local` rather than `date`: the stored column is an INSTANT, and a
 * calendar date is not one. A date picker would force the interface to invent
 * a time of day, and whichever it invented ("midnight", "end of day") would be
 * a convention the caller never chose and the API never states.
 *
 * The native control carries its own keyboard support, its own calendar popup
 * and its own locale — including the day/month order the reader expects — so
 * the field is accessible without this file re-implementing any of it. It
 * needs a NAME, which it gets from the caller's label or from the aria-label
 * below when there is no visible one.
 *
 * ── THE BROWSER CONSTRUCTS NO INSTANT ──
 *
 * This is the design change that ended three rounds of review, and it is the
 * whole reason this control is shorter than it used to be.
 *
 * A `datetime-local` edits a local WALL CLOCK. A wall clock is not a moment:
 * at the spring-forward jump it names none (there is no 02:30 on 29 March 2026
 * in Europe/Warsaw), at the autumn fall-back it names two, and in a historical
 * zone the offset that separates the two can carry SECONDS — Asia/Kolkata was
 * +05:21:10 in 1900. Every earlier version of this file tried to turn that
 * wall clock into an instant here, out of `Date`, `getTimezoneOffset()` and
 * string surgery on their output. Round 1 found that `Date` normalises an
 * impossible calendar. Round 2 found that it truncates the fraction and
 * silently moves a gap time. Round 3 found that the fraction repair assumed a
 * four-digit year and that `getTimezoneOffset()` rounds a historical offset to
 * whole minutes, storing an instant twenty-one seconds from the one named.
 *
 * So the conversion left the browser entirely. This control submits:
 *
 *   { local: '2026-03-29T02:30:00', zone: 'Europe/Warsaw' }
 *
 * — the wall clock exactly as written, and the name of the zone the browser
 * reports. No offset arithmetic. No `toISOString`. No `getTimezoneOffset`. No
 * `new Date(wallClock)`. There is nothing left here that can be wrong about a
 * timezone, because there is nothing here that decides one.
 *
 * The SERVER resolves the pair against PostgreSQL's IANA database — the same
 * database the column is stored with — refuses a local time that does not
 * exist with a named 400 that says which zone made it impossible, resolves an
 * ambiguous one using its documented policy and reports the chosen offset, and echoes
 * the canonical instant back. What this control then displays is that echo,
 * rendered by `utils/dateFormat`, never a value it derived.
 *
 * The refusal therefore arrives from the server rather than being computed
 * here, and it is stronger for it: the whole write is refused, so the other
 * fields on the form are not saved around a deadline that could not be read.
 */

/**
 * The same wall clock, spelled the one way.
 *
 * A live capture on the built product found this: Chrome accepts
 * `2026-09-02T18:49:00` and hands `event.target.value` back as
 * `2026-09-02T18:49`. The element sanitises a zero seconds field away, and a
 * guard that compared the two strings would have called that an EDIT. jsdom
 * does not sanitise, so no unit test could have seen it.
 *
 * It is string canonicalisation and nothing else: it appends the seconds the
 * element dropped. It parses nothing, and it names no instant.
 */
export function canonicalDateTimeLocal(value: string): string {
  return /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

/**
 * The name of the zone this browser is in, as the IANA database spells it.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the reader's own
 * zone NAME — 'Europe/Warsaw', not an offset — which is the only part of the
 * timezone question the browser is the right party to answer. Everything that
 * follows from the name (which offset applies on which day, whether the clock
 * the person typed exists at all) is a fact about the tz database, and the
 * server owns the tz database that the column is stored with.
 *
 * If no zone is available, the server refuses the empty name. UTC must never
 * stand in silently for an unknown reader timezone.
 */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone.length > 0 ? zone : '';
}

export function DueAtInput({ id, value, onChange, refusal = null, disabled = false }: {
  id?: string;
  /** The deadline AS THE SERVER LAST ECHOED IT — a canonical UTC instant — or
   *  null for no deadline. Never a value this control derived. */
  value: string | null | undefined;
  /** What to send: `{ local, zone }` for an edit, the echoed instant verbatim
   *  when the wall clock did not change, or null to clear the deadline. */
  onChange: (next: TaskDueAtWrite) => void;
  /** The server's refusal for this field, verbatim, while one stands. The
   *  page clears it the moment the person edits the field again. */
  refusal?: string | null;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const controlId = id ?? `due-at-${generatedId}`;
  const absoluteId = `${controlId}-absolute`;
  const refusalId = `${controlId}-refusal`;
  const rendered = formatInstantForDateTimeLocal(value ?? '');
  // What the person typed stays ON SCREEN. It is not the stored value — while
  // a refusal stands, nothing was stored — so an input driven by `value` alone
  // would snap back to the old deadline the instant the message appeared, and
  // the person would be told their entry was wrong while looking at an entry
  // they did not make.
  const [draft, setDraft] = useState<string | null>(null);
  // Round-3 review, observation 3: a draft that outlived an authoritative
  // `value` replacement left this control showing a clock the parent had
  // already moved past. Resetting during render, keyed on the value's
  // identity, is React's own answer to derived state and settles it without an
  // effect — and a successful save, which echoes a new instant, is exactly
  // such a replacement.
  const [seenValue, setSeenValue] = useState<string | null | undefined>(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(null);
  }
  return (
    <>
      <input
        id={controlId}
        type="datetime-local"
        aria-label="Due"
        // Seconds, so the control can show and keep what the column stores.
        step={1}
        disabled={disabled}
        aria-invalid={refusal ? true : undefined}
        // The absolute instant is not decoration: it is how a reader tells the
        // two 02:30s of a fall-back day apart, which their own clock cannot.
        // While the field is refused the message takes the description slot,
        // because that is the thing that needs saying.
        aria-describedby={refusal ? refusalId : (value ? absoluteId : undefined)}
        value={draft ?? rendered}
        onChange={event => {
          const next = event.target.value;
          setDraft(next);
          if (!next) {
            onChange(null);
            return;
          }
          // Round-1 review F4. A wall clock that has not changed is not an
          // edit, and re-submitting it as `{ local, zone }` would ask the
          // server to re-decide which side of an autumn fold an untouched
          // deadline meant. So the echoed instant goes back VERBATIM: its
          // microseconds and its side of the fold both survive, and only a
          // genuine edit is reinterpreted — which is what an edit means.
          if (value && canonicalDateTimeLocal(next) === canonicalDateTimeLocal(rendered)) {
            onChange(value);
            return;
          }
          onChange({ local: canonicalDateTimeLocal(next), zone: browserTimeZone() });
        }}
      />
      {refusal
        ? <span className="due-at-refusal" id={refusalId} role="alert">{refusal}</span>
        : (value ? <span className="due-at-absolute" id={absoluteId}>{formatInstantUtc(value)}</span> : null)}
    </>
  );
}

export function PersonalitySelect({ personalities, value, onChange }: {
  personalities: ReadonlyArray<PersonalitySummary>;
  value: string;
  onChange: (personalityId: string) => void;
}) {
  return (
    <Select aria-label="Personality" value={value} onChange={event => onChange(event.target.value)}>
      <option value="">— Select personality —</option>
      {personalities.map(personality => <option key={personality.id} value={personality.id}>{personality.name}</option>)}
    </Select>
  );
}

export function ModelInput({ value, onChange }: {
  value: string;
  onChange: (model: string) => void;
}) {
  return <input aria-label="Model" value={value} placeholder="Default model" onChange={event => onChange(event.target.value)} />;
}

export function ThinkingSelect({ value, onChange }: {
  value: string;
  onChange: (thinking: string) => void;
}) {
  return (
    <Select aria-label="Thinking" value={value} onChange={event => onChange(event.target.value)}>
      {THINKING_LEVEL_OPTIONS.map(level => <option key={level} value={level}>{level || 'Default'}</option>)}
    </Select>
  );
}

/** The common content-section shell (§7 "shared section components"): one
 *  heading pattern for both modes; edit mode passes its pencil action, create
 *  mode renders its always-open editor as children. */
export function TaskSectionShell({ id, heading, action, children }: {
  id: string;
  heading: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`task-detail-section-${id}`} className="task-detail-content-section" aria-labelledby={`task-detail-section-${id}-heading`}>
      <div className="task-detail-section-heading">
        <h2 id={`task-detail-section-${id}-heading`}>{heading}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** RH-UI.19 (amendment 2d5e2caa Ruling 1): the estate-wide edit affordance.
 *  A dotted frame marks the editable element; the corner pencil is icon-only
 *  visually but keeps the full accessible name — screen readers hear
 *  "Edit <label>", sighted users get it as a tooltip. */
export function EditableFrame({ label, onEdit, disabled = false, children }: {
  label: string;
  onEdit: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="editable-frame">
      {children}
      <IconButton
        className="editable-frame-edit"
        variant="ghost"
        ariaLabel={`Edit ${label}`}
        title={`Edit ${label}`}
        disabled={disabled}
        onClick={onEdit}
        icon={<Pencil size={16} aria-hidden="true" />}
      />
    </div>
  );
}
