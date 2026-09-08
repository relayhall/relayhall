// @vitest-environment jsdom
//
// 7d38a6e0 — A WALL CLOCK IS NOT AN INSTANT, AND THIS BROWSER NO LONGER
// PRETENDS OTHERWISE.
//
// The Task deadline is stored as an instant. The control that edits it,
// `<input type="datetime-local">`, edits a LOCAL WALL CLOCK, and the two are
// different kinds of thing. A timezone with daylight saving breaks the
// correspondence between them TWICE a year, in opposite ways:
//
//   THE FOLD (round-1 review F4). At the end of daylight saving an hour
//   repeats, so one wall clock names TWO instants and `new Date` picks the
//   first without being asked. A person who opened the editor on the second
//   02:30 and changed some other field moved the deadline back an hour.
//
//   THE GAP (round-2 review). At the start of daylight saving an hour is
//   skipped, so a wall clock inside it names NO instant, and `new Date` does
//   not say so — it answers with the moment an hour later.
//
// Rounds 1, 2 and 3 each tried to solve that HERE, in the browser, and each
// repair found a new boundary: the calendar, then the fraction, then the year
// width, then the resolution of `getTimezoneOffset()`, which returns whole
// minutes and so cannot state Europe/Paris's 1900 offset of +00:09:21.
//
// The design changed instead. THE BROWSER CONSTRUCTS NO INSTANT. It submits
// the wall clock exactly as written plus the IANA zone NAME, and the server
// resolves the pair against PostgreSQL's timezone database — refusing a clock
// that names no instant, and reporting which offset it used for one that names
// two. So what this file measures is no longer "did the browser convert it
// correctly" but the stronger thing: THE BROWSER DID NOT CONVERT IT AT ALL,
// and a wall clock the previous code silently moved now leaves the form
// untouched.
//
// The suite that first shipped could not see any of this: it ran in whatever
// timezone the runner had (UTC on CI), where no wall clock is ambiguous and
// none is missing. A property about timezones has to be measured in a timezone
// that has the property. So this file FAILS — never skips — unless it is
// running in a zone that has BOTH. `npm run test:unit:tz` sets Europe/Warsaw,
// which has a gap at 2026-03-29 02:30 and a fold at 2026-10-25 02:30; CI runs
// it as its own step. A skip here would be the same failure one level up: a
// control that reports success by not looking.
//
// The page-level cases drive the PRODUCTION create page through the production
// router and read what the form actually PUT ON THE WIRE, because the seam
// this is about — a wall clock becoming a request body — is not visible from a
// direct call to any helper.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import { TaskCreatePage } from '../../pages/TaskCreatePage';
import { formatInstantForDateTimeLocal } from '../../utils/dateFormat';
import { DueAtInput, browserTimeZone } from './taskFieldEditors';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('./ExecutionProfileEditor', () => ({
  __esModule: true,
  default: () => <button type="button">Pick connector</button>,
}));
vi.mock('./PhaseSelect', () => ({
  PhaseSelect: ({ value }: any) => <select aria-label="Phase" value={value} onChange={() => {}}><option value="">No phase</option></select>,
  PhaseName: ({ phaseId }: any) => <span>{phaseId}</span>,
}));

const ZONE = 'Europe/Warsaw';

/** Europe/Warsaw, 25 October 2026: 03:00 CEST becomes 02:00 CET.
 *  00:30Z is the FIRST 02:30 (CEST, +02:00); 01:30Z is the SECOND (CET, +01:00). */
const FIRST_0230 = '2026-10-25T00:30:00.000000Z';
const SECOND_0230 = '2026-10-25T01:30:00.000000Z';
const AMBIGUOUS_WALL_CLOCK = '2026-10-25T02:30:00';

/** Europe/Warsaw, 29 March 2026: 02:00 CET becomes 03:00 CEST. No 02:30 exists. */
const GAP_WALL_CLOCK = '2026-03-29T02:30:00';

/** Sub-second precision, which the control has no cell for at any hour. */
const WITH_MICROS = '2026-07-01T12:34:56.789012Z';

/** What the server answers for a wall clock inside the gap. Fixed text, as the
 *  API sends it, so this file does not model the message it is displaying. */
const SERVER_GAP_REFUSAL = 'dueAt names a local time that does not exist in Europe/Warsaw: '
  + 'the clocks move across it, so no instant reads back as that clock. Pick a time before '
  + 'or after the change';

/**
 * A `datetime-local` element with a zero seconds field reports its `value`
 * WITHOUT that field — `…T02:30`, not `…T02:30:00`. That is the same
 * sanitisation a real browser performs and the reason the identity guard
 * canonicalises before comparing; the DOM-level cases below compare the same
 * way rather than pretending the element echoes what was written into it.
 */
const asWallClock = (value: string): string =>
  (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value);

/**
 * The oracle, rebuilt here rather than imported.
 *
 * The environment assertions below have to say something about the ZONE THE
 * RUNNER IS IN, not about the repair, so they may not go through a production
 * helper — a helper edited into agreement with a broken zone would make them
 * pass. This is four lines of `Date`, in a test, which is the one place in
 * this feature where asking `Date` about a local clock is the right thing to
 * do: it is the outside anchor, not the mechanism.
 */
function localClockOf(instant: string): string {
  const date = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

describe('the environment this file needs', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  test('the timezone has a daylight-saving FOLD, or half this file proves nothing', () => {
    // Two different instants that render as one wall clock IS a fold.
    const rendered = [FIRST_0230, SECOND_0230].map(localClockOf);
    expect(
      rendered[0] === rendered[1] && rendered[0] === AMBIGUOUS_WALL_CLOCK,
      `TZ=${zone} renders ${FIRST_0230} and ${SECOND_0230} as ${rendered[0]} and `
      + `${rendered[1]}. This file measures what happens when one wall clock names two `
      + 'instants; run it with a zone that has a fold — npm run test:unit:tz sets '
      + 'TZ=Europe/Warsaw — rather than skipping it.',
    ).toBe(true);
  });

  test('the timezone has a daylight-saving GAP, or the other half proves nothing', () => {
    const asDate = new Date(GAP_WALL_CLOCK);
    expect(
      !Number.isNaN(asDate.getTime()) && localClockOf(asDate.toISOString()) !== GAP_WALL_CLOCK,
      `TZ=${zone} reads ${GAP_WALL_CLOCK} as a real local time. This file measures what `
      + 'happens when a wall clock names NO instant; run it with a zone that skips an '
      + 'hour — npm run test:unit:tz sets TZ=Europe/Warsaw — rather than skipping it.',
    ).toBe(true);
  });

  test('the production renderer agrees with that oracle, in this zone', () => {
    // The anchor is only worth having if it is compared with the real thing.
    for (const instant of [FIRST_0230, SECOND_0230, WITH_MICROS, '2026-01-15T08:00:00.000000Z']) {
      expect(formatInstantForDateTimeLocal(instant)).toBe(localClockOf(instant));
    }
  });

  test('the browser reports that zone BY NAME, which is the only thing it is asked for', () => {
    expect(browserTimeZone()).toBe(zone);
    expect(
      zone === ZONE,
      `TZ=${zone}, and the expectations below name ${ZONE} explicitly. `
      + 'Run it with npm run test:unit:tz.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The census. What is NOT in this browser any more.
// ---------------------------------------------------------------------------

/** Vitest runs from , and  is not a file URL under
 *  the jsdom environment, so the tree is located from the working directory.
 *  The control file is asserted to EXIST before it is searched: a census that
 *  reads nothing finds nothing, which is the way this kind of gate goes
 *  vacuous. */
const SRC = join(process.cwd(), 'src');
const CONTROL_FILE = join(SRC, 'components', 'tasks', 'taskFieldEditors.tsx');

/**
 * A file with its comments removed.
 *
 * The census below searches for names that must not be USED. This file, and
 * the control it inspects, both talk ABOUT those names at length — the whole
 * point of the repair is that they are gone — so a raw substring search would
 * be satisfied by prose and would fail on documentation. Comments are stripped
 * first, and `codeOf` is the same function for every file scanned, so the two
 * cases cannot drift about what "in the code" means.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

describe('the browser constructs no instant — the static half', () => {
  /**
   * A backstop, not the proof. The behavioural cases below are the proof; this
   * catches the same defect coming back in a shape they do not happen to
   * drive, which is exactly how rounds 2 and 3 each found the previous
   * repair's new boundary.
   */
  test('the deadline control names no date API at all', () => {
    expect(statSync(CONTROL_FILE).isFile()).toBe(true);
    const source = readFileSync(CONTROL_FILE, 'utf8');
    // Non-vacuity: the file really does discuss these names, so a `codeOf`
    // that stripped everything would pass this test for the wrong reason.
    expect(source).toContain('getTimezoneOffset');
    const code = codeOf(source);
    expect(code).toContain('canonicalDateTimeLocal');
    for (const forbidden of ['new Date', 'Date.', 'getTimezoneOffset', 'toISOString', 'getTime(']) {
      expect(code.includes(forbidden), `taskFieldEditors.tsx uses ${forbidden}. `
        + 'The control submits a wall clock and a zone NAME; every conversion to an instant '
        + 'happens on the server, against the timezone database the column is stored with.').toBe(false);
    }
  });

  test('nothing shipped in this interface asks for a timezone OFFSET', () => {
    // `getTimezoneOffset()` returns whole minutes and therefore cannot state
    // Europe/Paris's 1900 offset of +00:09:21 — round 3's blocking finding.
    // Nothing in the product should be asking the question at all.
    const files = sourceFilesUnder(SRC);
    // A census that reads nothing finds nothing. This is the way the gate
    // goes vacuous, so the count is asserted before the result is.
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter(file => codeOf(readFileSync(file, 'utf8')).includes('getTimezoneOffset'));
    expect(offenders.map(file => file.slice(SRC.length))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The behavioural half, at the control.
// ---------------------------------------------------------------------------

describe('a wall clock leaves the control exactly as it was written', () => {
  function emitted(stored: string | null, typed: string): unknown {
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={stored} onChange={onChange} />);
    act(() => { tree.root.findByType('input').props.onChange({ target: { value: typed } }); });
    return onChange.mock.calls[0]?.[0];
  }

  test('the GAP hour is submitted UNCHANGED, with the zone that makes it a question', () => {
    // This is the round-2 defect asserted from the other side. The old control
    // handed `new Date('2026-03-29T02:30:00')` back its own answer — the
    // instant an HOUR LATER — and showed 03:30 without a word. Now the hour
    // the person typed is what leaves the form, and the server is the party
    // that says it does not exist.
    expect(emitted(null, GAP_WALL_CLOCK)).toEqual({ local: GAP_WALL_CLOCK, zone: ZONE });
  });

  test('the AMBIGUOUS hour is submitted UNCHANGED — the browser picks no side', () => {
    // The previous control emitted `…T02:30:00+02:00`, choosing the first
    // occurrence on the reader's behalf. Choosing is the server's job, and it
    // says which one it chose.
    expect(emitted(null, AMBIGUOUS_WALL_CLOCK)).toEqual({ local: AMBIGUOUS_WALL_CLOCK, zone: ZONE });
  });

  test('an ordinary hour goes the same way, in winter and in summer', () => {
    // The control for the two above: a component that emitted a constant, or
    // that treated the transition days specially, would satisfy them.
    expect(emitted(null, '2026-01-15T09:00:00')).toEqual({ local: '2026-01-15T09:00:00', zone: ZONE });
    expect(emitted(null, '2026-07-15T09:00:00')).toEqual({ local: '2026-07-15T09:00:00', zone: ZONE });
  });

  test('nothing that leaves the control carries an offset or a Z', () => {
    // The property, stated over the shape rather than over three examples: a
    // wall clock plus a zone name, and no third thing.
    for (const typed of [GAP_WALL_CLOCK, AMBIGUOUS_WALL_CLOCK, '2026-01-15T09:00:00']) {
      const value = emitted(null, typed) as { local: string; zone: string };
      expect(Object.keys(value).sort()).toEqual(['local', 'zone']);
      expect(value.local).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);
    }
  });

  test('the browser sanitising zero seconds away does not change what is sent', () => {
    // Found on the BUILT product: Chrome takes `…T09:15:00` and reports
    // `event.target.value` as `…T09:15`. jsdom does not, so this is asserted
    // in the shape a real browser produces.
    expect(emitted(null, '2026-01-15T09:15')).toEqual({ local: '2026-01-15T09:15:00', zone: ZONE });
  });

  test('an emptied control still clears the deadline', () => {
    expect(emitted(SECOND_0230, '')).toBeNull();
  });
});

describe('the control does not change a deadline nobody edited', () => {
  /**
   * Round-1 review F4 survives the design change, and matters more under it: a
   * wall clock re-submitted as `{ local, zone }` would ask the server to
   * re-decide which side of the fold an untouched deadline meant, and the
   * server's rule would move one of the two stored occurrences by an
   * hour. So an unchanged clock emits the STORED INSTANT VERBATIM.
   *
   * `browserSanitised` reproduces what a real browser does and jsdom does not.
   */
  function emitUnchanged(stored: string, browserSanitised = false): unknown {
    const onChange = vi.fn();
    const tree = renderer.create(<DueAtInput value={stored} onChange={onChange} />);
    const input = tree.root.findByType('input');
    const shown = browserSanitised
      ? String(input.props.value).replace(/:00$/, '')
      : input.props.value;
    act(() => { input.props.onChange({ target: { value: shown } }); });
    return onChange.mock.calls[0]?.[0];
  }

  test('the SECOND 02:30 stays the second 02:30', () => {
    expect(emitUnchanged(SECOND_0230)).toBe(SECOND_0230);
    expect(emitUnchanged(SECOND_0230, true)).toBe(SECOND_0230);
  });

  test('the FIRST 02:30 stays the first 02:30', () => {
    expect(emitUnchanged(FIRST_0230)).toBe(FIRST_0230);
    expect(emitUnchanged(FIRST_0230, true)).toBe(FIRST_0230);
  });

  test('year9999 UTC can display as local year10000 without reinterpreting an unchanged deadline', () => {
    const stored = '9999-12-31T23:59:00.123456Z';
    const shown = formatInstantForDateTimeLocal(stored);
    expect(shown).toBe('10000-01-01T00:59:00');
    expect(emitUnchanged(stored, true)).toBe(stored);
  });

  test('microseconds survive, which no wall clock could carry', () => {
    expect(emitUnchanged(WITH_MICROS)).toBe(WITH_MICROS);
  });
});

// ---------------------------------------------------------------------------
// Through the production page, on the production router.
// ---------------------------------------------------------------------------

const created: Array<Record<string, unknown>> = [];
let refuseDueAt = false;

const renderCreate = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tasks/new']}>
        <Routes>
          <Route path="/tasks/new" element={<TaskCreatePage />} />
          <Route path="/tasks/:taskId" element={<output data-testid="created" />} />
          <Route path="/tasks" element={<output data-testid="board" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  created.length = 0;
  refuseDueAt = false;
  vi.mocked(authenticatedFetch).mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/projects')) {
      return new Response(JSON.stringify({ success: true, projects: [] }), { status: 200 });
    }
    if (url.endsWith('/personalities')) {
      return new Response(JSON.stringify({ success: true, personalities: [] }), { status: 200 });
    }
    if (url.endsWith('/tasks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (refuseDueAt) {
        // The envelope the API actually answers with — 400, a stable code, the
        // field named. Nothing is stored.
        return new Response(
          JSON.stringify({ success: false, error: SERVER_GAP_REFUSAL, code: 'INVALID_DUE_AT_LOCAL_TIME', details: { field: 'dueAt' } }),
          { status: 400 },
        );
      }
      created.push(body);
      return new Response(
        JSON.stringify({ success: true, task: { id: '99999999-9999-4999-8999-999999999999', ...body } }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the form, on a day the clocks change', () => {
  test('a gap time is put on the wire as the clock the person typed', async () => {
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Spring forward' } });
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: GAP_WALL_CLOCK } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(created).toHaveLength(1));
    // NOT the instant an hour later, which is what every previous version of
    // this control sent. The hour the person typed, and the zone that decides
    // whether it exists.
    expect(created[0].dueAt).toEqual({ local: GAP_WALL_CLOCK, zone: ZONE });
  });

  test('the server\'s refusal lands ON the field, and the form stops re-sending it', async () => {
    refuseDueAt = true;
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Spring forward' } });
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: GAP_WALL_CLOCK } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    // Said, by name and naming the zone, in the description the input points at.
    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent(SERVER_GAP_REFUSAL);
    expect(refusal).toHaveTextContent(ZONE);
    const input = screen.getByLabelText('Due') as HTMLInputElement;
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(refusal.id);
    // NOT replaced by anything: what the person typed is still on screen.
    expect(asWallClock(input.value)).toBe(GAP_WALL_CLOCK);
    // Nothing was created, and the button will not post the same value again
    // until the person changes it.
    expect(created).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();

    // Editing the field clears the refusal — the control for the disable.
    fireEvent.change(input, { target: { value: '2026-03-29T03:30:00' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled();
  });

  test('an ambiguous time is submitted as the wall clock, with no side chosen', async () => {
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Fall back' } });
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: AMBIGUOUS_WALL_CLOCK } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].dueAt).toEqual({ local: AMBIGUOUS_WALL_CLOCK, zone: ZONE });
  });

  test('the absolute instant is rendered beside the field and named as its description', async () => {
    // The local clock cannot tell the two 02:30s apart; this is how a reader
    // can. A11y: the input keeps its own label AND points at the rendering.
    const onChange = vi.fn();
    const { container } = render(<DueAtInput value={SECOND_0230} onChange={onChange} />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(asWallClock(input.value)).toBe(AMBIGUOUS_WALL_CLOCK);
    const describedBy = input.getAttribute('aria-describedby') as string;
    const description = container.querySelector(`#${CSS.escape(describedBy)}`) as HTMLElement;
    expect(description.textContent).toBe('25/10/2026, 01:30 UTC');

    const other = render(<DueAtInput value={FIRST_0230} onChange={onChange} />);
    const otherInput = other.container.querySelector('input') as HTMLInputElement;
    expect(asWallClock(otherInput.value)).toBe(AMBIGUOUS_WALL_CLOCK);
    const otherDescribed = otherInput.getAttribute('aria-describedby') as string;
    expect((other.container.querySelector(`#${CSS.escape(otherDescribed)}`) as HTMLElement).textContent)
      .toBe('25/10/2026, 00:30 UTC');
  });

  test('an authoritative value replacement settles the draft — round-3 observation 3', () => {
    // A refused clock that outlived a `value` replacement left this control
    // showing something the parent had already moved past. A save echoes a new
    // instant, which is exactly such a replacement.
    const onChange = vi.fn();
    const { container, rerender } = render(<DueAtInput value={FIRST_0230} onChange={onChange} />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: GAP_WALL_CLOCK } });
    expect(asWallClock((container.querySelector('input') as HTMLInputElement).value)).toBe(GAP_WALL_CLOCK);
    rerender(<DueAtInput value={SECOND_0230} onChange={onChange} />);
    expect(asWallClock((container.querySelector('input') as HTMLInputElement).value)).toBe(AMBIGUOUS_WALL_CLOCK);
  });
});
