// @vitest-environment jsdom
/**
 * AuditPage against mocked ROUTES — card 96aeacb7.
 *
 * The house pattern for a page test mocks `usePrincipals`/`useMyPrincipal`
 * alongside `authenticatedFetch`. This file deliberately does not: it replaces
 * ONE thing, the HTTP seam, and lets the real hooks run against it. Two of the
 * claims this page makes live exactly in that seam — that a refusal comes from
 * the BOARD rather than from a scope check in this file, and that no request
 * leaves for any URL but the two named below — and a test that stubbed the
 * hooks could not see either.
 *
 * Every response here is shaped like the real one: `routes/audit.ts` returns
 * `{ success, events, nextCursor, retention, purgeAvailable }`.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditPage } from './AuditPage';
// The page's own source, for the one claim that is about what is ABSENT.
import pageSource from './AuditPage.tsx?raw';

const authenticatedFetch = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'owner', displayName: 'The Owner', kind: 'human', status: 'active', role: 'orchestrator',
};
const AGENT = {
  id: '22222222-2222-4222-8222-222222222222',
  handle: 'agent-7', displayName: null, kind: 'agent', status: 'active', role: 'agent',
};

const EVENTS = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    occurredAt: '2026-09-04T09:15:00.000Z',
    action: 'credential.mint', outcome: 'success',
    actorPrincipalId: OWNER.id, actorHandle: 'owner', authMethod: 'session',
    credentialId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'principal', resourceId: AGENT.id,
    metadata: { scopes: ['tasks:read'] },
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    occurredAt: '2026-09-03T08:00:00.000Z',
    action: 'grant.revoke', outcome: 'denied',
    actorPrincipalId: AGENT.id, actorHandle: 'agent-7', authMethod: 'principal_api_key',
    credentialId: null, resourceType: 'grant', resourceId: null,
    metadata: {},
  },
];

/** Every URL the page asked for, in order. */
let calls: string[] = [];

interface RouteAnswers {
  scopes?: string[] | null;
  audit?: (url: URL) => { status: number; body: unknown };
}

function serve(answers: RouteAnswers = {}) {
  const scopes = answers.scopes === undefined ? ['root'] : answers.scopes;
  authenticatedFetch.mockImplementation((raw: string) => {
    calls.push(raw);
    const url = new URL(raw, 'http://board.test');
    const reply = (status: number, body: unknown) => Promise.resolve({
      ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
    });
    if (url.pathname.endsWith('/principals/me')) {
      return reply(200, { success: true, principal: OWNER, scopes });
    }
    if (url.pathname.endsWith('/principals')) {
      return reply(200, { success: true, principals: [OWNER, AGENT] });
    }
    if (url.pathname.endsWith('/audit')) {
      const answer = answers.audit
        ? answers.audit(url)
        : { status: 200, body: { success: true, events: EVENTS, nextCursor: null, retention: 'indefinite', purgeAvailable: false } };
      return reply(answer.status, answer.body);
    }
    throw new Error(`unmocked route: ${raw}`);
  });
}

/** The audit request the page most recently made, as a URL. */
function lastAuditCall(): URL {
  const audit = calls.filter((call) => call.includes('/audit'));
  expect(audit.length).toBeGreaterThan(0);
  return new URL(audit[audit.length - 1], 'http://board.test');
}

/** The rendered record, never the filter controls: "Succeeded", "Refused"
 *  and an actor's name are all option labels in the form as well. */
const record = () => within(screen.getByRole('list', { name: /Recorded actions/ }));
const rows = () => record().getAllByRole('listitem').map(
  (item) => within(item).getByRole('button'),
);

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  serve();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AuditPage reads the shipped audit record', () => {
  test('renders the ledger the route returns, newest first', async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(screen.getByText('grant.revoke')).toBeInTheDocument();
    const listed = rows();
    expect(listed).toHaveLength(2);
    // The route orders newest-first; the page must not reorder it.
    expect(listed[0]).toHaveTextContent('credential.mint');
    expect(listed[1]).toHaveTextContent('grant.revoke');
    expect(record().getByText('Succeeded')).toBeInTheDocument();
    expect(record().getByText('Refused')).toBeInTheDocument();
  });

  test('an actor is named from the directory, and falls back to the recorded handle', async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    // The Owner has a display name in the directory.
    expect(record().getByText('The Owner (owner)')).toBeInTheDocument();
    // The Agent has none, so the row shows what the LEDGER recorded — the
    // ledger's handle is the durable fact, the directory only decorates it.
    expect(record().getByText('agent-7')).toBeInTheDocument();
  });

  test('the instant is machine-exact and the text is unambiguous', async () => {
    const { container } = render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    const times = Array.from(container.querySelectorAll('time'));
    expect(times.length).toBeGreaterThan(0);
    // The datetime attribute is the ledger's own UTC instant, unaltered.
    expect(times.map((node) => node.getAttribute('dateTime') ?? node.getAttribute('datetime')))
      .toEqual(['2026-09-04T09:15:00.000Z', '2026-09-03T08:00:00.000Z']);
    // The visible text is the house format, measured against its ratified
    // SHAPE rather than re-derived from the formatter this page calls: a test
    // that recomputes the expectation from the code under test agrees with
    // whatever that code does (dd/mm/yyyy, hh:mm — card 96984e2c).
    for (const node of times) {
      expect(node.textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    }
  });

  test('asks NO route but the two it needs', async () => {
    // The ledger, and the directory that puts a display name on an actor.
    // `/principals/me` left with the scope catalogue (round-1 review O1):
    // the page no longer asks anyone whether it may ask.
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    const paths = new Set(calls.map((call) => new URL(call, 'http://board.test').pathname));
    expect([...paths].sort()).toEqual(['/api/audit', '/api/principals']);
  });
});

describe('the board is the authority on who may read it, and this file is not', () => {
  // Round-1 review OBSERVATION O1. An earlier draft kept the two scope names
  // in the page and used them to skip a request it expected to be refused.
  // That is a second authority catalogue: the day the route accepts a third
  // scope, the page denies a session the board would have served. The
  // catalogue is withdrawn, so what these tests hold is that the ANSWER comes
  // from the route in every direction.
  test.each([
    ['a session the board reports as holding neither scope', ['tasks:read', 'reports:read']],
    ['a session the board reports no scopes for at all', null],
    ['a session the board reports as holding exactly audit:read', ['audit:read']],
  ])('%s is ASKED, and the route decides', async (_label, scopes) => {
    serve({ scopes: scopes as string[] | null });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(calls.some((call) => call.includes('/audit'))).toBe(true);
  });

  test('the page names no scope of its own to decide with', () => {
    // The mechanism is withdrawn, not bounded: there is no list here to rot.
    expect(pageSource).not.toMatch(/READ_SCOPES/);
    expect(pageSource).not.toMatch(/scopes\s*\.\s*includes/);
    expect(pageSource).not.toMatch(/useMyPrincipal/);
  });

  test('a refusal is an answer, not an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    serve({ audit: () => ({ status: 403, body: { success: false, error: 'FORBIDDEN' } }) });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent('audit:read'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('a 401 is treated the same way, because an expired session is not a defect', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    serve({ audit: () => ({ status: 401, body: {} }) });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole('note')).toBeInTheDocument());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('a failed read leaves nothing behind to reason with', () => {
  // Round-1 review, PRODUCTION P3. Rows were suppressed as unreadable while
  // the header kept claiming a count from the previous query and "load older
  // events" kept offering the PREVIOUS query's cursor under the NEW filters.
  const paged = () => serve({
    audit: (url) => ({
      status: 200,
      body: url.searchParams.get('before') === 'cursor-1'
        ? { success: true, events: [{ ...EVENTS[1], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', action: 'task.arm' }], nextCursor: null, retention: 'indefinite', purgeAvailable: false }
        : { success: true, events: EVENTS, nextCursor: 'cursor-1', retention: 'indefinite', purgeAvailable: false },
    }),
  });

  test('an unaskable fresh filter takes the count and the cursor with it', async () => {
    const user = userEvent.setup();
    paged();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(screen.getByText(/2\+ events/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load older events/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Action starts with'), '.nope');
    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/events?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2\+ events/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load older events/ })).not.toBeInTheDocument();
    expect(screen.queryByText('credential.mint')).not.toBeInTheDocument();
  });

  test('a fresh read that fails does the same', async () => {
    const user = userEvent.setup();
    let fail = false;
    serve({
      audit: () => (fail
        ? { status: 500, body: { success: false, message: 'The ledger could not be read' } }
        : { status: 200, body: { success: true, events: EVENTS, nextCursor: 'cursor-1', retention: 'indefinite', purgeAvailable: false } }),
    });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText(/2\+ events/)).toBeInTheDocument());

    fail = true;
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be read'));
    expect(screen.queryByText(/2\+ events/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load older/ })).not.toBeInTheDocument();
  });

  test('an OLDER answer cannot land on top of an unaskable fresh question', async () => {
    // Round-2 review, PRODUCTION P3-R2. The unaskable arm above returned
    // BEFORE the request counter advanced, so a request already in flight was
    // still the current one. It landed after the invalid filter had cleared
    // the record and put the PREVIOUS query's rows, count and cursor back —
    // beside the new filter's error, and with a "Try again" carrying a cursor
    // belonging to a query nobody was looking at. It stayed that way.
    //
    // The response is held open here rather than raced, so this either
    // reproduces the defect or proves it gone; it cannot pass by timing.
    const user = userEvent.setup();
    let releaseAudit: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { releaseAudit = resolve; });
    authenticatedFetch.mockImplementation(async (raw: string) => {
      calls.push(raw);
      const url = new URL(raw, 'http://board.test');
      if (url.pathname.endsWith('/principals/me')) {
        return { ok: true, status: 200, json: async () => ({ success: true, principal: OWNER, scopes: ['root'] }) };
      }
      if (url.pathname.endsWith('/principals')) {
        return { ok: true, status: 200, json: async () => ({ success: true, principals: [OWNER, AGENT] }) };
      }
      // The FIRST audit request never answers until this test lets it.
      if (calls.filter((call) => call.includes('/audit')).length === 1) await held;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true, events: EVENTS, nextCursor: 'cursor-1',
          retention: 'indefinite', purgeAvailable: false,
        }),
      };
    });

    render(<AuditPage />);
    await waitFor(() => expect(calls.some((call) => call.includes('/audit'))).toBe(true));
    // Nothing has been answered yet, so nothing is on screen to be kept.
    expect(screen.queryByText('credential.mint')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Action starts with'), '.nope');
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // NOW the old request answers, with rows and a cursor.
    (releaseAudit as unknown as () => void)();
    await held;
    // Two turns of the microtask queue plus a macrotask: whatever that
    // response was going to write, it has written by here.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(screen.getByRole('alert'), 'the new filter stopped being refused').toBeInTheDocument();
    expect(screen.queryByText('credential.mint'),
      'an older query answered a question that had already been replaced').not.toBeInTheDocument();
    expect(screen.queryByText(/\d\+ events/),
      'a count arrived for a query that never ran').not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load older events/ }),
      'a cursor from a different query was offered').not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ }),
      'a retry was offered for a query that was never sent').not.toBeInTheDocument();
    // And the invalid question spent no request of its own.
    expect(calls.filter((call) => call.includes('/audit'))).toHaveLength(1);
  });

  test('but a failed LOAD MORE keeps the rows it already read, and retries', async () => {
    // These rows were read successfully. Throwing them away because the NEXT
    // page failed would be the opposite defect.
    const user = userEvent.setup();
    let failMore = false;
    serve({
      audit: (url) => (url.searchParams.get('before') && failMore
        ? { status: 500, body: { success: false, message: 'The ledger could not be read' } }
        : { status: 200, body: { success: true, events: EVENTS, nextCursor: 'cursor-1', retention: 'indefinite', purgeAvailable: false } }),
    });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    failMore = true;
    await user.click(screen.getByRole('button', { name: /Load older events/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be read'));
    expect(screen.getByText('credential.mint')).toBeInTheDocument();
    expect(screen.getByText(/2\+ events/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

describe('the filters narrow at the route, not in the browser', () => {
  test('every control becomes a query parameter on the audit request', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Actor'), AGENT.id);
    await user.type(screen.getByLabelText('Action starts with'), 'credential.');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'denied');
    await user.type(screen.getByLabelText('Target type'), 'principal');
    await user.type(screen.getByLabelText('Target id'), OWNER.id);
    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => {
      const url = lastAuditCall();
      expect(url.searchParams.get('actorPrincipalId')).toBe(AGENT.id);
      expect(url.searchParams.get('actionPrefix')).toBe('credential.');
      expect(url.searchParams.get('outcome')).toBe('denied');
      expect(url.searchParams.get('resourceType')).toBe('principal');
      expect(url.searchParams.get('resourceId')).toBe(OWNER.id);
      expect(url.searchParams.get('limit')).toBe('50');
    });
  });

  test('a wall-clock window is sent as a UTC instant', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await user.type(screen.getByLabelText('From'), '2026-09-01T00:00');
    await user.type(screen.getByLabelText(/^To/), '2026-09-05T00:00');
    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => {
      const url = lastAuditCall();
      // A `datetime-local` value carries no offset. What reaches the ledger
      // must be an instant, and the route accepts only this spelling.
      expect(url.searchParams.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(url.searchParams.get('until')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(url.searchParams.get('since')!))
        .toBeLessThan(Date.parse(url.searchParams.get('until')!));
    });
  });

  test('an inverted window is refused here, without spending a request', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    const before = calls.filter((call) => call.includes('/audit')).length;

    await user.type(screen.getByLabelText('From'), '2026-09-05T00:00');
    await user.type(screen.getByLabelText(/^To/), '2026-09-01T00:00');
    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('earlier than'));
    expect(calls.filter((call) => call.includes('/audit')).length).toBe(before);
  });

  test('a prefix the route would reject is refused here too, with words', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    const before = calls.filter((call) => call.includes('/audit')).length;

    await user.type(screen.getByLabelText('Action starts with'), '.nope');
    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('lower-case letters'));
    expect(calls.filter((call) => call.includes('/audit')).length).toBe(before);
  });

  test('an empty result says which kind of empty it is', async () => {
    const user = userEvent.setup();
    serve({
      audit: (url) => ({
        status: 200,
        body: {
          success: true,
          events: url.searchParams.has('actionPrefix') ? [] : EVENTS,
          nextCursor: null, retention: 'indefinite', purgeAvailable: false,
        },
      }),
    });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Action starts with'), 'nothing.matches');
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(screen.getByText(/No recorded action matches these filters/)).toBeInTheDocument());
  });

  test('a genuinely empty ledger reads as empty, not as a fault', async () => {
    serve({
      audit: () => ({ status: 200, body: { success: true, events: [], nextCursor: null, retention: 'indefinite', purgeAvailable: false } }),
    });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText(/Nothing has been recorded yet/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a failing read says so, and does not pretend the ledger is empty', async () => {
    serve({ audit: () => ({ status: 500, body: { success: false, message: 'Something went wrong' } }) });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'));
    expect(screen.queryByText(/Nothing has been recorded yet/)).not.toBeInTheDocument();
  });
});

describe('paging follows the route own cursor', () => {
  test('load older sends before=<cursor> and appends rather than replaces', async () => {
    const user = userEvent.setup();
    const older = { ...EVENTS[1], id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', action: 'task.arm' };
    serve({
      audit: (url) => ({
        status: 200,
        body: url.searchParams.get('before') === 'cursor-1'
          ? { success: true, events: [older], nextCursor: null, retention: 'indefinite', purgeAvailable: false }
          : { success: true, events: EVENTS, nextCursor: 'cursor-1', retention: 'indefinite', purgeAvailable: false },
      }),
    });
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Load older events/ }));
    await waitFor(() => expect(screen.getByText('task.arm')).toBeInTheDocument());
    expect(lastAuditCall().searchParams.get('before')).toBe('cursor-1');
    // The first page must still be on screen: this is "older", not "instead".
    expect(screen.getByText('credential.mint')).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Load older events/ })).not.toBeInTheDocument();
  });
});

describe('one row, opened', () => {
  test('the drawer names the act and shows what was recorded with it', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await user.click(rows()[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'credential.mint' })).toBeInTheDocument();
    expect(within(dialog).getByText('session')).toBeInTheDocument();
    expect(within(dialog).getByText('33333333-3333-4333-8333-333333333333')).toBeInTheDocument();
    expect(within(dialog).getByText(/"scopes"/)).toBeInTheDocument();
    // An act with no credential says so rather than showing a blank cell.
    await user.keyboard('{Escape}');
    await user.click(rows()[1]);
    expect(within(await screen.findByRole('dialog')).getByText('Not a credentialled act')).toBeInTheDocument();
  });

  test('Escape closes it and returns focus to the row it was opened from', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    const opener = rows()[1];
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Not the top of the document: a keyboard reader must come back to the
    // row they were on.
    expect(document.activeElement).toBe(opener);
  });

  test('Tab cycles inside the drawer, in both directions', async () => {
    // aria-modal="true" tells a screen reader "nothing outside this matters".
    // Tab walking out into the record behind it would make that untrue.
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    await user.click(rows()[0]);
    const dialog = await screen.findByRole('dialog');

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
    expect(focusables.length).toBeGreaterThan(0);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);

    // And the record behind it never receives focus while it is open.
    expect(rows()).not.toContain(document.activeElement);
  });

  test('the record is announced as expanded while its drawer is open', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'false');
    await user.click(rows()[0]);
    await screen.findByRole('dialog');
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the record is walkable from the keyboard', () => {
  test('arrow keys move between rows and Home/End reach the ends', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    const listed = rows();
    listed[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(listed[1]);
    await user.keyboard('{ArrowDown}');
    // The last row is the end of the list, not a wrap onto the first.
    expect(document.activeElement).toBe(listed[1]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(listed[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(listed[1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(listed[0]);
  });

  test('Enter on a focused row opens its drawer', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    rows()[0].focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
