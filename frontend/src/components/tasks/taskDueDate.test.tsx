// @vitest-environment jsdom
/**
 * 7d38a6e0 — A DEADLINE THE INTERFACE CAN SHOW AND A PERSON CAN SET.
 *
 * Three properties, because a due date is easy to get subtly wrong in three
 * different ways:
 *
 *   ONE RENDERING. `formatRelativeDue` is the only place a deadline becomes
 *   relative text, and `dueTone` is the only place an instant becomes a state.
 *   The board chip and the Task page both call them, so they cannot drift
 *   apart the way three `toLocaleString()` calls once did (card 96984e2c).
 *
 *   URGENCY IS IN THE WORDS. WCAG 1.4.1: a state a reader has to see in a hue
 *   is a state some readers never see. The chip's own text says "Overdue by",
 *   the tone class only reinforces it — so the assertions here are about the
 *   TEXT, and the class is checked separately as reinforcement.
 *
 *   WHAT YOU PICK IS WHAT IS STORED. The control is `datetime-local` because
 *   the column is an INSTANT. A date picker would make the interface invent a
 *   time of day; the round trip below proves nothing is invented — the value
 *   that leaves the control is the value that came in.
 */
import renderer, { act } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

import { TaskCard } from './TaskCard';
import { DueAtInput, browserTimeZone } from './taskFieldEditors';
import { DUE_SOON_MS, dueTone, formatInstantForDateTimeLocal, formatRelativeDue } from '../../utils/dateFormat';
import type { Task } from '../../types/task';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function taskWith(dueAt: string | null): Task {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'A Task with a deadline',
    description: '',
    status: 'todo',
    priority: 'normal',
    subtasks: [],
    links: [],
    sessionRefs: [],
    autoCreated: false,
    autoStart: false,
    blockedBy: [],
    tags: [],
    created: NOW.toISOString(),
    updated: NOW.toISOString(),
    dueAt,
  } as unknown as Task;
}

function renderCard(dueAt: string | null) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MemoryRouter>
        <TaskCard
          task={taskWith(dueAt)}
          onDragStart={() => undefined}
          onDragEnd={() => undefined}
          onUpdate={() => undefined}
          onSubtaskTransition={async () => undefined}
          onDelete={() => undefined}
        />
      </MemoryRouter>,
    );
  });
  return tree;
}

function chipOf(tree: renderer.ReactTestRenderer) {
  const found = tree.root.findAll(
    node => typeof node.type === 'string'
      && typeof node.props.className === 'string'
      && node.props.className.startsWith('task-card-due'),
  );
  return found[0];
}

function textOf(node: renderer.ReactTestInstance | undefined): string {
  if (!node) return '';
  const walk = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(walk).join('');
    if (value && typeof value === 'object' && 'children' in (value as any)) {
      return walk((value as any).children);
    }
    return '';
  };
  const collect = (instance: renderer.ReactTestInstance): string =>
    instance.children.map(child => (typeof child === 'string' ? child : collect(child))).join('');
  return collect(node) || walk(node.props.children);
}

// ─────────────────────── one rendering, one state machine ────────────────────

describe('formatRelativeDue says the distance, and only in one place', () => {
  test.each([
    ['2026-09-07T12:00:00.000Z', 'Due in 2 d'],
    ['2026-09-05T18:00:00.000Z', 'Due in 6 h'],
    ['2026-09-05T12:30:00.000Z', 'Due in 30 min'],
    ['2026-09-05T09:00:00.000Z', 'Overdue by 3 h'],
    ['2026-09-02T12:00:00.000Z', 'Overdue by 3 d'],
    ['2026-10-05T12:00:00.000Z', 'Due in 30 d'],
  ])('%s reads as %s', (instant, expected) => {
    expect(formatRelativeDue(instant, NOW)).toBe(expected);
  });

  test.each([
    ['2026-09-05T12:00:00.000Z', 'the deadline is exactly now'],
    ['2026-09-05T12:00:30.000Z', 'half a minute ahead'],
    ['2026-09-05T11:59:30.000Z', 'half a minute behind'],
    ['2026-09-05T12:00:59.999Z', 'the last instant before a minute ahead'],
  ])('%s reads as "Due now" — %s', (instant) => {
    // Round-1 review F5. A deadline that has just passed used to read "Due in
    // under a minute", which says the wrong thing about which side of it the
    // reader is on; and at delta zero the deadline is not in the future at
    // all. Inside a minute either way there is no distance left to report.
    expect(formatRelativeDue(instant, NOW)).toBe('Due now');
  });

  test('the "Due now" window is exactly one minute wide, from both sides', () => {
    // The boundary, measured from both sides, so a widened window shows up.
    expect(formatRelativeDue('2026-09-05T12:01:00.000Z', NOW)).toBe('Due in 1 min');
    expect(formatRelativeDue('2026-09-05T11:59:00.000Z', NOW)).toBe('Overdue by 1 min');
  });

  test('it truncates rather than rounds, so 47 hours is never "1 d"', () => {
    // A deadline 47 hours away is still today-and-tomorrow work. Rounding up
    // to "in 2 d" would make a card claim more time than it has.
    expect(formatRelativeDue('2026-09-07T11:00:00.000Z', NOW)).toBe('Due in 1 d');
    expect(formatRelativeDue('2026-09-07T12:00:00.000Z', NOW)).toBe('Due in 2 d');
  });

  test('an unparsable value returns the fallback, never "Invalid Date"', () => {
    expect(formatRelativeDue('not a date', NOW, 'unknown')).toBe('unknown');
    expect(formatRelativeDue('', NOW)).toBe('');
  });
});

describe('dueTone decides the state once, at the boundary it names', () => {
  test('no deadline is not a state at all', () => {
    expect(dueTone(null, NOW)).toBe('none');
    expect(dueTone(undefined, NOW)).toBe('none');
    expect(dueTone('', NOW)).toBe('none');
  });

  test('the soon boundary is exactly DUE_SOON_MS, measured from both sides', () => {
    const atBoundary = new Date(NOW.getTime() + DUE_SOON_MS).toISOString();
    const justPast = new Date(NOW.getTime() + DUE_SOON_MS + 1).toISOString();
    expect(dueTone(atBoundary, NOW)).toBe('soon');
    expect(dueTone(justPast, NOW)).toBe('later');
  });

  test('the overdue boundary is now, measured from both sides', () => {
    expect(dueTone(new Date(NOW.getTime()).toISOString(), NOW)).toBe('soon');
    expect(dueTone(new Date(NOW.getTime() - 1).toISOString(), NOW)).toBe('overdue');
  });
});

// ─────────────────────────── the chip on the card ────────────────────────────

describe('the board card shows the deadline in words', () => {
  test('a Task with no deadline renders no chip', () => {
    // The control: if a chip appeared regardless, every assertion below would
    // hold for a card that renders the same thing for every Task.
    expect(chipOf(renderCard(null))).toBeUndefined();
  });

  test('a Task with a deadline renders one', () => {
    // Relative to the REAL clock, deliberately: the card reads `Date.now()`
    // itself, and a faked clock inside a React render is a second thing that
    // can be wrong. Three days out is unambiguously future from any now this
    // suite can run at.
    const chip = chipOf(renderCard(new Date(Date.now() + 3 * 24 * 3600_000).toISOString()));
    expect(chip).toBeDefined();
    expect(textOf(chip)).toContain('Due in');
  });

  test('overdue is legible with no colour at all', () => {
    // WCAG 1.4.1. Strip every class from the assertion and the state must
    // still be readable, because it is in the text.
    const chip = chipOf(renderCard('2020-01-01T00:00:00.000Z'));
    expect(textOf(chip)).toContain('Overdue by');
    // and the tone is present as REINFORCEMENT, not as the carrier
    expect(chip.props.className).toContain('task-card-due--overdue');
  });

  test('the exact instant is never lost to the abbreviation', () => {
    // The chip says "Due in 2 d". A person who needs the date itself gets it
    // from the title, and a screen reader gets it from the sr-only suffix —
    // so the card abbreviates without hiding anything. Midday UTC, so no
    // timezone this suite can run in moves the calendar day.
    const tree = renderCard('2030-09-07T12:00:00.000Z');
    const chip = chipOf(tree);
    expect(chip.props.title).toContain('7 September 2030');
    const srOnly = tree.root.findAll(
      node => typeof node.type === 'string' && node.props.className === 'sr-only',
    );
    expect(srOnly.map(node => textOf(node)).join(' ')).toContain('7 September 2030');
  });
});

// ───────────────────────── the control on the pages ──────────────────────────

describe('the deadline control submits a wall clock and a zone, never an instant', () => {
  /* ROUND 4, THE DESIGN CHANGE. Three review rounds each found a new boundary
     in a browser-side conversion from wall clock to instant — the calendar,
     the fraction, the four-digit year, the minute-resolution offset. The
     conversion is gone. What this control now does is show an instant the
     server echoed, and hand back either that same instant untouched or the
     wall clock the person typed with the NAME of the zone to read it in. */

  test('an instant renders into the control machine format, in every locale', () => {
    // The rendering direction, which is all that is left: a moment becomes
    // characters, the way every other formatter in dateFormat works. Built
    // from a local-midday instant so no timezone this suite can run in moves
    // the calendar day.
    const iso = new Date(2026, 8, 7, 17, 5, 0).toISOString();
    expect(formatInstantForDateTimeLocal(iso)).toBe('2026-09-07T17:05:00');
  });

  test('SECONDS survive the rendering — round-1 review F4', () => {
    // The control stopped at minutes, so a deadline stored with seconds was
    // truncated the moment anyone opened the editor. The control's precision
    // is now seconds, which is the precision the product renders.
    const iso = new Date(2026, 8, 7, 17, 5, 43).toISOString();
    expect(formatInstantForDateTimeLocal(iso)).toBe('2026-09-07T17:05:43');
  });

  test('an unreadable value renders as an empty control, never "Invalid Date"', () => {
    expect(formatInstantForDateTimeLocal('')).toBe('');
    expect(formatInstantForDateTimeLocal('not a date')).toBe('');
  });

  test('the control is a real date input and carries an accessible name', () => {
    const tree = renderer.create(<DueAtInput value={null} onChange={() => undefined} />);
    const input = tree.root.findByType('input');
    expect(input.props.type).toBe('datetime-local');
    expect(input.props['aria-label']).toBe('Due');
  });

  test('the control offers seconds, so what it shows is what is stored', () => {
    const tree = renderer.create(<DueAtInput value={null} onChange={() => undefined} />);
    expect(tree.root.findByType('input').props.step).toBe(1);
  });

  test('an unchanged control emits the STORED instant, byte for byte', () => {
    // Round-1 review F4, and it matters MORE under the new design: a wall
    // clock re-submitted as { local, zone } would ask the server to re-decide
    // which side of an autumn fold an untouched deadline meant. Sub-second
    // precision has no cell in the control either, so re-deriving would lose
    // it. Nothing changed, so nothing is re-derived.
    const stored = '2026-11-01T05:30:00.789012Z';
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={stored} onChange={onChange} />);
    const input = tree.root.findByType('input');
    act(() => { input.props.onChange({ target: { value: input.props.value } }); });
    expect(onChange).toHaveBeenCalledWith(stored);
  });

  test('the browser may sanitise zero seconds away, and that is not an edit', () => {
    // Found on the BUILT product, not here: Chrome takes `...T18:49:00` and
    // reports `event.target.value` as `...T18:49`. jsdom hands back exactly
    // what it was given, so a bare string comparison passed in this file and
    // would have re-derived the value in a real browser.
    const stored = new Date(2026, 8, 2, 18, 49, 0, 250).toISOString();
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={stored} onChange={onChange} />);
    const input = tree.root.findByType('input');
    expect(input.props.value).toMatch(/T\d{2}:\d{2}:00$/);
    act(() => {
      input.props.onChange({ target: { value: input.props.value.replace(/:00$/, '') } });
    });
    expect(onChange).toHaveBeenCalledWith(stored);
  });

  test('a control the person actually changed sends the CLOCK and the ZONE', () => {
    // The control for the control: a component that always echoed its input
    // would satisfy the two tests above and would make the field uneditable.
    // And what it sends is exactly what was typed — no offset, no Z, no
    // instant. The server owns the timezone database; this does not.
    const stored = new Date(2026, 8, 7, 17, 0, 0).toISOString();
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={stored} onChange={onChange} />);
    act(() => {
      tree.root.findByType('input').props.onChange({ target: { value: '2026-09-09T09:15:00' } });
    });
    expect(onChange).toHaveBeenCalledWith({ local: '2026-09-09T09:15:00', zone: browserTimeZone() });
  });

  test('clearing the control reports null, not an empty string', () => {
    // The API distinguishes them: null CLEARS the deadline, '' would have to
    // be interpreted, and interpreting it is where a convention gets invented.
    const onChange = vi.fn();
    const tree = renderer.create(
      <DueAtInput value={new Date(2026, 8, 7, 17, 0, 0).toISOString()} onChange={onChange} />,
    );
    act(() => {
      tree.root.findByType('input').props.onChange({ target: { value: '' } });
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('a refusal the server sent is shown on the field, as an alert it points at', () => {
    // The refusal is no longer computed here — a local time that names no
    // instant is a fact about a timezone database, and the server owns it.
    // What this control owes is that the answer is announced where it
    // happened: aria-invalid on the input, role=alert on the message, and the
    // description slot pointing at it.
    const refusal = 'dueAt names a local time that does not exist in Europe/Warsaw';
    const tree = renderer.create(
      <DueAtInput value={null} refusal={refusal} onChange={() => undefined} />,
    );
    const input = tree.root.findByType('input');
    expect(input.props['aria-invalid']).toBe(true);
    const alert = tree.root.findAll(node => node.props.role === 'alert')[0];
    expect(alert.props.children).toBe(refusal);
    expect(input.props['aria-describedby']).toBe(alert.props.id);
  });

  test('with no refusal the description is the absolute instant, not an alert', () => {
    // The control for the case above: an input that always reported itself
    // invalid, or always rendered an alert, would satisfy it.
    const tree = renderer.create(
      <DueAtInput value={'2026-11-01T05:30:00.000000Z'} onChange={() => undefined} />,
    );
    const input = tree.root.findByType('input');
    expect(input.props['aria-invalid']).toBeUndefined();
    expect(tree.root.findAll(node => node.props.role === 'alert')).toHaveLength(0);
    expect(String(input.props['aria-describedby'])).toMatch(/-absolute$/);
  });
});

test('a missing browser timezone is submitted as unknown rather than silently guessed as UTC', () => {
  const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: undefined } as any);
  try {
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={null} onChange={onChange} />);
    act(() => { tree.root.findByType('input').props.onChange({ target: { value: '2026-09-07T12:00:00' } }); });
    expect(onChange).toHaveBeenCalledWith({ local: '2026-09-07T12:00:00', zone: '' });
  } finally { spy.mockRestore(); }
});
