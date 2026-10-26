/*
 * THE SHARED-AREA WRITER LIST PANEL (card 549cc51f; owner rulings E298, E299, E310).
 *
 * Pinned here is what the panel SHOWS, what it OFFERS and what it SENDS. The
 * board is the authority on every refusal, so this file does not restate one:
 * it measures that a session the board refuses the administration view to sees
 * nothing at all, that the picker offers only the identities the route accepts,
 * that every change asks for a step-up bound to the act and the Account before
 * anything is sent, and that the request carries the token, the reason and a
 * retry key.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SharedWritersPanel, SHARED_WRITER_STEP_UP_ACTIONS } from './SharedWritersPanel';
import type { StepUpRequest } from './accessShared';
import type { Principal } from '../../types/task';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const SOURCE = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'brain', name: 'Brain' };
const GRACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const principal = (over: Partial<Principal> & { id: string; handle: string }): Principal => ({
  kind: 'human', displayName: null, status: 'active', role: 'user', parentPrincipalId: null, ...over,
} as Principal);

const PEOPLE: Principal[] = [
  principal({ id: ADA, handle: 'ada', displayName: 'Ada Lovelace' }),
  principal({ id: GRACE, handle: 'grace', displayName: 'Grace Hopper' }),
  principal({ id: 'p-sys', handle: 'system' }),
  principal({ id: 'p-disabled', handle: 'dora', status: 'disabled' }),
  principal({ id: 'p-conn', handle: 'connector-laptop', kind: 'service', parentPrincipalId: ADA }),
  principal({ id: 'p-svc', handle: 'service-account', kind: 'service' }),
  principal({ id: 'p-agent', handle: 'agent-7', kind: 'agent', parentPrincipalId: 'p-conn' }),
  principal({ id: 'p-group', handle: 'team', kind: 'group' as Principal['kind'] }),
];

const LISTED = {
  accountId: ADA, label: 'Ada Lovelace', active: true,
  addedBy: { id: 'root-id', label: 'Root' }, addedAt: '2026-10-16T09:00:00.000Z',
  reason: 'Maintains the organisation rules and the runbooks.', expiresAt: null, approvalId: null, origin: 'direct',
};

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const refused = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload });
const listAnswer = (writers = [LISTED]) => ok({ success: true, source: SOURCE, scope: 'organisation', writers, youCanWrite: false });

const surface = vi.fn();
let stepUps: StepUpRequest[] = [];

const renderPanel = (auditTrailAvailable = true) => render(
  <MemoryRouter>
    <main>
      <h1>Access manager</h1>
      <SharedWritersPanel
        principals={PEOPLE}
        requestStepUp={(request) => { stepUps.push(request); }}
        surface={surface}
        auditTrailAvailable={auditTrailAvailable}
      />
    </main>
  </MemoryRouter>,
);

beforeEach(() => {
  fetchMock.mockReset();
  surface.mockReset();
  stepUps = [];
});
afterEach(cleanup);

describe('who sees it', () => {
  it('asks the board for the administration view, and shows the list it answers', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    renderPanel();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/knowledge-shared-writers\?view=administration$/);
    expect(screen.getByText(/Added by Root/)).toBeInTheDocument();
    expect(screen.getByText(/does not expire/)).toBeInTheDocument();
    expect(screen.getByText(/origin: added directly/)).toBeInTheDocument();
    expect(screen.getByText(/Maintains the organisation rules/)).toBeInTheDocument();
  });

  it.each([403, 401])('a session the board refuses the view to (%i) sees NOTHING, not an error', async (status) => {
    fetchMock.mockResolvedValue(refused(status, { success: false, code: 'SHARED_WRITER_REQUIRES_ADMINISTRATOR', message: 'no' }));
    const { container } = renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText('Shared-area writers')).toBeNull();
    expect(surface).not.toHaveBeenCalled();
  });

  it('an answer without the list shape renders nothing and never throws', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    const { container } = renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText('Shared-area writers')).toBeNull();
  });

  it('every Remove button is named by its Account', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Remove Ada Lovelace' })).toBeInTheDocument();
  });

  it('no write-configured source is a sentence, not a failure', async () => {
    fetchMock.mockResolvedValue(refused(404, { success: false, code: 'SHARED_WRITER_SOURCE_NOT_FOUND', message: 'No write-configured knowledge source exists' }));
    renderPanel();
    expect(await screen.findByText(/once a knowledge source accepts writes/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('two write-configured sources ask which one, then read that one', async () => {
    fetchMock
      .mockResolvedValueOnce(refused(400, { success: false, code: 'SHARED_WRITER_SOURCE_REQUIRED', message: 'More than one knowledge source accepts writes: name one with source' }))
      .mockResolvedValue(listAnswer());
    const user = userEvent.setup();
    renderPanel();
    await user.type(await screen.findByLabelText('Knowledge source id'), SOURCE.id);
    await user.click(screen.getByRole('button', { name: 'Show its writers' }));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1][0])).toContain(`source=${SOURCE.id}`);
  });

  it('links to the audit trail of these changes only when the audit log is served', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    renderPanel(true);
    const link = await screen.findByRole('link', { name: 'Audit trail of these changes' });
    expect(link.getAttribute('href')).toBe('/audit?actionPrefix=knowledge.shared_writer');
    cleanup();
    fetchMock.mockResolvedValue(listAnswer());
    renderPanel(false);
    await screen.findByText('Ada Lovelace');
    expect(screen.queryByRole('link', { name: 'Audit trail of these changes' })).toBeNull();
  });
});

describe('what it offers', () => {
  it('the picker lists active, parentless human Accounts not already listed, and nobody else', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    renderPanel();
    await screen.findByText('Ada Lovelace');
    const offered = Array.from((screen.getByLabelText('Account') as HTMLSelectElement).options)
      .map((option) => option.textContent || '').join(' | ');
    expect(offered).toContain('Grace Hopper (grace)');
    for (const absent of ['ada', 'system', 'dora', 'connector-laptop', 'service-account', 'agent-7', 'team']) {
      expect(offered).not.toContain(absent);
    }
  });

  it('a reason under 20 characters keeps the act unavailable, and says why', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Ada Lovelace');
    await user.selectOptions(screen.getByLabelText('Account'), GRACE);
    await user.type(screen.getByLabelText('Why can this Account write the shared area?'), 'too short');
    expect(screen.getByText('A reason is at least 20 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add with step-up' })).toBeDisabled();
    // The help text describes the field it sits under.
    expect(screen.getByLabelText('Why can this Account write the shared area?').getAttribute('aria-describedby'))
      .toBe('axm-shared-writers-reason-help');
  });
});

describe('what it sends', () => {
  it('ADD: a step-up bound to (knowledge.shared-writer.add, the Account) first, then ONE keyed POST carrying the token', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Ada Lovelace');
    await user.selectOptions(screen.getByLabelText('Account'), GRACE);
    await user.type(screen.getByLabelText('Why can this Account write the shared area?'), 'Writes the release runbook for everyone.');
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Add with step-up' }));
    // Nothing leaves before the step-up.
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(stepUps).toHaveLength(1);
    expect(stepUps[0]).toMatchObject({ action: SHARED_WRITER_STEP_UP_ACTIONS.add, targetId: GRACE });
    expect(stepUps[0].description).toMatch(/Grace Hopper/);

    fetchMock.mockResolvedValueOnce(ok({ success: true, action: 'add', before: [ADA], after: [ADA, GRACE] }));
    fetchMock.mockResolvedValue(listAnswer());
    await stepUps[0].onToken('rhsu_token');
    const post = fetchMock.mock.calls[before];
    expect(String(post[0])).toMatch(/\/knowledge-shared-writers$/);
    expect(post[1].method).toBe('POST');
    expect(post[1].headers['Idempotency-Key']).toMatch(/.{16,}/);
    expect(JSON.parse(post[1].body)).toEqual({
      source: SOURCE.id, accountId: GRACE, reason: 'Writes the release runbook for everyone.', stepUpToken: 'rhsu_token',
    });
    await waitFor(() => expect(surface).toHaveBeenCalledWith('notice', expect.stringContaining('Grace Hopper')));
  });

  it('REMOVE: a reason, then a step-up bound to (knowledge.shared-writer.remove, the Account), then the remove POST', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    await user.type(screen.getByLabelText('Why remove Ada Lovelace?'), 'Moved to another team this week.');
    await user.click(screen.getByRole('button', { name: 'Remove with step-up' }));
    expect(stepUps).toHaveLength(1);
    expect(stepUps[0]).toMatchObject({ action: SHARED_WRITER_STEP_UP_ACTIONS.remove, targetId: ADA });
    const before = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(ok({ success: true, action: 'remove', before: [ADA], after: [] }));
    fetchMock.mockResolvedValue(listAnswer([]));
    await stepUps[0].onToken('rhsu_remove');
    const post = fetchMock.mock.calls[before];
    expect(String(post[0])).toMatch(/\/knowledge-shared-writers\/remove$/);
    expect(JSON.parse(post[1].body)).toEqual({
      source: SOURCE.id, accountId: ADA, reason: 'Moved to another team this week.', stepUpToken: 'rhsu_remove',
    });
    expect(await screen.findByText('Nobody can write this shared area yet.')).toBeInTheDocument();
  });

  it('a refusal is shown as the board words it, with its code', async () => {
    fetchMock.mockResolvedValue(listAnswer());
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Ada Lovelace');
    await user.selectOptions(screen.getByLabelText('Account'), GRACE);
    await user.type(screen.getByLabelText('Why can this Account write the shared area?'), 'Writes the release runbook for everyone.');
    await user.click(screen.getByRole('button', { name: 'Add with step-up' }));
    fetchMock.mockResolvedValueOnce(refused(403, { success: false, code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token' }));
    await stepUps[0].onToken('rhsu_stale');
    expect(await screen.findByRole('alert')).toHaveTextContent('This act requires a live single-use step-up token (STEP_UP_REQUIRED)');
  });
});
