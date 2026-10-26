// @vitest-environment jsdom
/**
 * The universal change request's surfaces (card 502fb19e, slice S3; design
 * sections 5.4, 6 and 9.4): the generic decide form narrows only by the
 * fields its target type admits and sends only what was narrowed; the Before
 * and after region shows a decider the relationships and a requester the
 * fields only; the "Request a change" dialog files what the preview admits on
 * the session door; My requests lists the requester's own items and withdraws
 * a pending one its Account filed.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let replies: Array<{ match: (url: string, method: string) => boolean; status: number; body: unknown }> = [];
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const reply = replies.find((candidate) => candidate.match(url, method));
    const status = reply?.status ?? 200;
    return new Response(JSON.stringify(reply?.body ?? { success: true }), { status });
  }),
}));
vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => ({ me: { id: 'p-me', role: 'user', handle: 'me' }, loading: false }),
  usePrincipals: () => ({ principals: [
    { id: 'p-me', kind: 'human', handle: 'me', status: 'active' },
    { id: 'p-reader', kind: 'human', handle: 'reader-one', status: 'active' },
    { id: 'p-gone', kind: 'human', handle: 'gone', status: 'disabled' },
  ] }),
}));

import { BeforeAndAfter, ChangeRequestDetail, editedChangeOf, exactIdsOf, narrowerRoles, specFieldDiff } from './ChangeRequestDetail';
import { RequestChangeDialog } from './RequestChangeDialog';
import { MyRequests, RequestRoleChange } from './MyRequests';
import type { ApprovalItem } from './approvals';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const IN_14_DAYS = new Date(Date.now() + 14 * 86400000).toISOString();

function item(overrides: Partial<ApprovalItem> & { targetType: string; requested: Record<string, unknown> }): ApprovalItem {
  const { targetType, requested, ...rest } = overrides;
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'change', status: 'pending', requesterPrincipalId: 'p-requester',
    requesterHandle: 'requester', targetTaskId: null, targetTaskTitle: null, requestedScopes: [], requestedRules: [],
    approvedScopes: null, lapseReason: null, denialReason: null, requestedAt: new Date().toISOString(),
    pendingExpiresAt: IN_14_DAYS, collectExpiresAt: null,
    change: {
      targetType, targetId: null, targetObjects: null, granteeType: 'principal', granteePrincipalId: 'p-reader', granteeHandle: 'reader-one',
      reason: 'The assistant needs the notes of these projects.',
      spec: { type: targetType, before: {}, requested, approved: null, diff: null },
      appliedAt: null, appliedEffect: null, deciderStanding: null, relatedTaskId: null, relatedPhaseId: null,
    },
    fieldDiff: [{ field: 'projectIds', before: null, after: [P1, P2] }],
    relationships: { summary: '1 principal gains read on 2 objects; nothing is removed', edges: [
      { principal: { type: 'principal', id: 'p-reader' }, object: `compartment:${P1}`, action: 'read', before: false, after: true, via: 'knowledge', state: 'added' },
    ] },
    view: 'decider', decidable: true,
    ...rest,
  } as ApprovalItem;
}

const draft = (patch: Record<string, unknown>) => ({
  rules: [], scopes: [], projectIds: [], operation: 'read', transport: 'any', expiryDate: '', role: '', ...patch,
}) as Parameters<typeof editedChangeOf>[2];

beforeEach(() => { calls.length = 0; replies = []; });
afterEach(() => cleanup());

describe('the narrowing of each target type (section 5.4)', () => {
  test('grant.rows: an unticked verb or object is sent; nothing unticked sends nothing; an empty row is invalid', () => {
    const rule = { resourceType: 'project', selectorForm: 'exact' as const, selectorIds: [P1, P2], verbs: ['read', 'write'] };
    const requested = { rules: [rule], expiresAt: IN_14_DAYS };
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [rule] }))).toEqual({ edited: null, invalid: null });
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [{ ...rule, verbs: ['read'], selectorIds: [P1] }] })).edited)
      .toEqual({ rules: [{ ...rule, verbs: ['read'], selectorIds: [P1] }] });
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [{ ...rule, verbs: [] }] })).invalid).toMatch(/Keep at least one row/);
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [null] })).invalid).toMatch(/Keep at least one row/);
  });

  test('grant.rows: an all-of-type row narrows to exact ids; a non-UUID or an empty id list is invalid', () => {
    const rule = { resourceType: 'task', selectorForm: 'all-of-type' as const, selectorIds: [] as string[], verbs: ['read'] };
    const requested = { rules: [rule], expiresAt: IN_14_DAYS };
    const exact = { ...rule, selectorForm: 'exact' as const, selectorIds: [P1, P2] };
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [exact] })).edited).toEqual({ rules: [exact] });
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [{ ...exact, selectorIds: [P1, 'not-an-id'] }] })).invalid).toMatch(/full UUIDs/);
    expect(editedChangeOf('grant.rows', requested, draft({ rules: [{ ...exact, selectorIds: [] }] })).invalid).toMatch(/Keep at least one row/);
    expect(exactIdsOf(` ${P1}, ${P2};${P1}\n`)).toEqual([P1, P2]);
  });

  test('knowledge.compartment: drop a Project, write to read; dropping every Project is invalid', () => {
    const requested = { sourceId: 's', operation: 'write', projectIds: [P1, P2], expiresAt: IN_14_DAYS };
    expect(editedChangeOf('knowledge.compartment', requested, draft({ projectIds: [P2], operation: 'read' })).edited)
      .toEqual({ projectIds: [P2], operation: 'read' });
    expect(editedChangeOf('knowledge.compartment', requested, draft({ projectIds: [], operation: 'write' })).invalid).toMatch(/at least one Project/);
  });

  test('credential.issue: untick a scope and narrow the pin; a shorter expiry is the end of that day, never later than requested', () => {
    const requested = { scopes: ['tasks:read', 'reports:read'], transport: 'any', expiresAt: IN_14_DAYS };
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const out = editedChangeOf('credential.issue', requested, draft({ scopes: ['reports:read'], transport: 'mcp', expiryDate: tomorrow }));
    expect(out.edited).toEqual({ scopes: ['reports:read'], transport: 'mcp', expiresAt: `${tomorrow}T23:59:59.000Z` });
    const past = editedChangeOf('credential.issue', requested, draft({ scopes: ['reports:read'], expiryDate: '2000-01-01' }));
    expect(past.invalid).toMatch(/future date/);
  });
});

describe('the generic decide form', () => {
  test('a decider reads the relationships; dropping a Project approves narrowed with only projectIds sent', async () => {
    const onDecide = vi.fn();
    render(<MemoryRouter><ChangeRequestDetail approval={item({ targetType: 'knowledge.compartment',
      requested: { sourceId: 's', operation: 'read', projectIds: [P1, P2], expiresAt: IN_14_DAYS } })} mayDecide busy={false} onDecide={onDecide} /></MemoryRouter>);
    const region = screen.getByRole('region', { name: 'Before and after' });
    expect(within(region).getByRole('table', { name: 'Relationships' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: P2 }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve narrowed' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve', editedChange: { projectIds: [P1] } }));
  });

  test('an all-of-type grant row narrows to the exact ids the decider types, sent as rules[].selectorForm exact', async () => {
    const onDecide = vi.fn();
    const rule = { resourceType: 'task', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read', 'write'] };
    render(<MemoryRouter><ChangeRequestDetail approval={item({ targetType: 'grant.rows', requested: { rules: [rule], expiresAt: IN_14_DAYS } })}
      mayDecide busy={false} onDecide={onDecide} /></MemoryRouter>);
    const selector = screen.getByLabelText('Selector for task');
    expect(selector).toHaveValue('all-of-type');
    expect(screen.getByRole('button', { name: 'Approve as requested' })).toBeEnabled();
    await userEvent.selectOptions(selector, 'exact');
    // No id typed yet: nothing approvable is left on the row.
    expect(screen.getByRole('alert')).toHaveTextContent(/Keep at least one row/);
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
    const ids = screen.getByLabelText(/^Exact task ids/);
    await userEvent.type(ids, 'not-an-id');
    expect(screen.getByRole('alert')).toHaveTextContent(/full UUIDs/);
    await userEvent.clear(ids);
    await userEvent.type(ids, `${P1}, ${P2}`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve narrowed' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'approve',
      editedChange: { rules: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [P1, P2], verbs: ['read', 'write'] }] },
    }));
  });

  test('the requester reads the fields only, offers no decision, and is told why', () => {
    render(<MemoryRouter><ChangeRequestDetail approval={item({ targetType: 'grant.revoke', requested: {}, view: 'requester', relationships: null,
      decidable: false, decisionRefusal: { code: 'SELF_DECISION_REFUSED', message: 'another person decides' } })} mayDecide={false} busy={false} onDecide={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('table', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Relationships' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByText(/You do not decide this change: another person decides/)).toBeInTheDocument();
  });

  test('a plain queue row with no hub field diff reads the diff from its own spec, and points to the hub to decide', () => {
    const plain = item({ targetType: 'grant.edit', requested: { verb: 'read' }, fieldDiff: undefined, relationships: undefined,
      view: undefined, decidable: undefined });
    plain.change!.spec.before = { verb: 'write', expiresAt: null };
    expect(specFieldDiff(plain.change!.spec)).toEqual([{ field: 'verb', before: 'write', after: 'read' }]);
    render(<MemoryRouter><ChangeRequestDetail approval={plain} mayDecide={false} busy={false} onDecide={vi.fn()} /></MemoryRouter>);
    expect(within(screen.getByRole('table', { name: 'Fields' })).getByText('write')).toBeInTheDocument();
    expect(screen.getByText(/decided on the approvals hub/)).toBeInTheDocument();
  });

  test('Before and after says so when no field changes', () => {
    render(<BeforeAndAfter fields={[]} />);
    expect(screen.getByRole('region', { name: 'Before and after' })).toHaveTextContent('No field changes.');
  });
});

describe('the Request a change dialog', () => {
  test('on a Project: reads the preview, hides disabled principals, and files grant rows for the chosen Account', async () => {
    replies = [
      { match: (url) => url.includes('/approvals/requests/preview'), status: 200, body: { success: true,
        requestable: [{ targetType: 'grant.rows', grantees: 'any', fields: ['rules', 'expiresAt'], bound: { verbs: ['read', 'write'] },
          deciders: [{ standing: 'root', rule: 'Root, or the owner, with step-up.' }] }], refused: [] } },
      { match: (url) => url.includes('/knowledge-sources'), status: 200, body: { success: true, sources: [] } },
      { match: (url, method) => url.endsWith('/approvals/requests') && method === 'POST', status: 202,
        body: { success: true, approval: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } },
    ];
    render(<MemoryRouter><RequestChangeDialog target={{ kind: 'project', projectId: P1, projectName: 'Garden' }} onClose={vi.fn()} /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'read' }));
    const forSelect = screen.getByLabelText('For');
    expect(within(forSelect).queryByText('gone')).not.toBeInTheDocument();
    await userEvent.selectOptions(forSelect, 'p-reader');
    await userEvent.type(screen.getByLabelText(/^Reason/), 'The reader needs to read this project for the handover.');
    await userEvent.click(screen.getByRole('button', { name: 'File the request' }));
    await screen.findByText(/Filed\. Request bbbbbbbb waits for a decision: Root, or the owner, with step-up\./);
    const filed = calls.find((call) => call.method === 'POST')!;
    expect(filed.body).toEqual({
      targetType: 'grant.rows', granteePrincipalId: 'p-reader', reason: 'The reader needs to read this project for the handover.',
      change: { rules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [P1], verbs: ['read'] }] },
    });
  });

  const P3 = '33333333-3333-4333-8333-333333333333';
  const compartmentPreview = (projectId: string, answer: 'requestable' | 'refused') => ({
    match: (url: string, method: string) => method === 'GET' && url.includes('/approvals/requests/preview?')
      && url.includes(`targetId=${projectId}`) && url.includes('sourceId=src-1') && url.includes('objectType=project'),
    status: 200,
    body: answer === 'requestable'
      ? { success: true, refused: [], requestable: [{ targetType: 'knowledge.compartment', grantees: 'self', fields: ['projectIds'], bound: { operations: ['read'] },
        deciders: [{ standing: 'owner', rule: 'Root, an administrator, or the owner of every object it names.' }] }] }
      : { success: true, requestable: [], refused: [{ targetType: 'knowledge.compartment', code: 'KNOWLEDGE_NOT_EXPORTED' }] },
  });

  test('from the Knowledge page: previews each ticked Project, names a refusal before filing, and files the requestable ones in one request', async () => {
    replies = [
      compartmentPreview(P1, 'requestable'), compartmentPreview(P2, 'refused'), compartmentPreview(P3, 'requestable'),
      { match: (url) => url.includes('/projects'), status: 200, body: { success: true, projects: [{ id: P1, name: 'One' }, { id: P2, name: 'Two' }, { id: P3, name: 'Three' }] } },
      { match: (url, method) => url.endsWith('/approvals/requests') && method === 'POST', status: 202,
        body: { success: true, approval: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } } },
    ];
    render(<MemoryRouter><RequestChangeDialog target={{ kind: 'knowledge', sources: [{ id: 'src-1', name: 'Brain' }] }} onClose={vi.fn()} /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', { name: /One/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Two/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Three/ }));
    await userEvent.type(screen.getByLabelText(/^Reason/), 'My assistant needs the notes of my projects.');
    // The refused Project is named by its code, and nothing can be filed while it is ticked.
    expect(await screen.findByRole('alert')).toHaveTextContent('Two: refused (KNOWLEDGE_NOT_EXPORTED)');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/One|Three/);
    expect(screen.getByRole('button', { name: 'File the request' })).toBeDisabled();
    // Each ticked Project was previewed once, for the chosen source; the preview wrote nothing.
    const previews = calls.filter((call) => call.url.includes('/approvals/requests/preview?'));
    expect(previews.map((call) => new URL(call.url, 'http://board').searchParams.get('targetId')).sort()).toEqual([P1, P2, P3].sort());
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: /Two/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'File the request' }));
    await screen.findByText(/Filed\. Request dddddddd waits for a decision: Root, an administrator, or the owner of every object it names\./);
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{
      targetType: 'knowledge.compartment', reason: 'My assistant needs the notes of my projects.',
      change: { sourceId: 'src-1', operation: 'read', projectIds: [P1, P3] },
    }]);
  });

  test('from the Knowledge page: a refusal at filing (the preview cannot see it) is still shown by name', async () => {
    replies = [
      compartmentPreview(P1, 'requestable'), compartmentPreview(P2, 'requestable'),
      { match: (url) => url.includes('/projects'), status: 200, body: { success: true, projects: [{ id: P1, name: 'One' }, { id: P2, name: 'Two' }] } },
      { match: (url, method) => url.endsWith('/approvals/requests') && method === 'POST', status: 409,
        body: { error: 'Refused', code: 'TARGET_OUT_OF_SCOPE', message: 'the Projects have different owners' } },
    ];
    render(<MemoryRouter><RequestChangeDialog target={{ kind: 'knowledge', sources: [{ id: 'src-1', name: 'Brain' }] }} onClose={vi.fn()} /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', { name: /One/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Two/ }));
    await userEvent.type(screen.getByLabelText(/^Reason/), 'My assistant needs the notes of my projects.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'File the request' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'File the request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refused (TARGET_OUT_OF_SCOPE): the Projects have different owners');
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      targetType: 'knowledge.compartment', reason: 'My assistant needs the notes of my projects.',
      change: { sourceId: 'src-1', operation: 'read', projectIds: [P1, P2] },
    });
  });

  test('a short reason keeps the request unfiled', async () => {
    render(<MemoryRouter><RequestChangeDialog target={{ kind: 'knowledge', sources: [] }} onClose={vi.fn()} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText(/Knowledge Service id/), P1);
    await userEvent.type(screen.getByLabelText(/^Reason/), 'too short');
    expect(screen.getByRole('button', { name: 'File the request' })).toBeDisabled();
  });
});

describe('My requests', () => {
  test('lists only the requester side, and withdraws a pending request its own Account filed', async () => {
    const mine = item({ targetType: 'grant.rows', requested: { rules: [] }, view: 'requester', relationships: null, requesterPrincipalId: 'p-me' });
    const decided = item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', targetType: 'grant.rows', requested: {}, view: 'decider' });
    replies = [
      { match: (url) => url.includes('/approvals?view=hub&status=all&kind=change'), status: 200, body: { success: true, approvals: [mine, decided] } },
      { match: (url, method) => url.includes('/withdraw') && method === 'POST', status: 200, body: { success: true } },
    ];
    render(<MemoryRouter><MyRequests /></MemoryRouter>);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(within(list).getByRole('button', { name: /^Withdraw: Grant rows/ }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith(`/approvals/${mine.id}/withdraw`))).toBe(true));
  });
});

describe('the identity targets (card 9ce0b0b0, slice S4)', () => {
  test('identity.role narrows to a lower role only: the requested one, or a lower one other than the role held', () => {
    expect(narrowerRoles('operator', 'viewer')).toEqual(['operator', 'editor', 'user', 'reviewer', 'qa', 'agent']);
    expect(narrowerRoles('editor', 'viewer')).toEqual(['editor']);
    expect(editedChangeOf('identity.role', { role: 'operator' }, draft({ role: 'operator' }))).toEqual({ edited: null, invalid: null });
    expect(editedChangeOf('identity.role', { role: 'operator' }, draft({ role: 'editor' })).edited).toEqual({ role: 'editor' });
  });

  test('a role change offers the lower roles; a revoke is approved or denied as filed', async () => {
    const onDecide = vi.fn();
    const role = item({ targetType: 'identity.role', requested: { role: 'operator' } });
    role.change!.spec.before = { role: 'viewer' };
    render(<MemoryRouter><ChangeRequestDetail approval={role} mayDecide busy={false} onDecide={onDecide} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'A role' })).toBeInTheDocument();
    const select = screen.getByLabelText(/^Role/) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['operator', 'editor', 'user', 'reviewer', 'qa', 'agent']);
    await userEvent.selectOptions(select, 'editor');
    await userEvent.click(screen.getByRole('button', { name: 'Approve narrowed' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve', editedChange: { role: 'editor' } }));
    cleanup();
    render(<MemoryRouter><ChangeRequestDetail approval={item({ targetType: 'credential.revoke', requested: { revoke: true } })}
      mayDecide busy={false} onDecide={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/approved or denied as filed/)).toBeInTheDocument();
  });

  test('an object target (slice S5) reads by its words and is approved or denied as filed, with nothing to narrow', async () => {
    const onDecide = vi.fn();
    const verifier = item({ targetType: 'project.default_verifier', requested: { defaultVerifierPrincipalId: 'p-verifier' } });
    verifier.change!.spec.before = { defaultVerifierPrincipalId: null };
    render(<MemoryRouter><ChangeRequestDetail approval={verifier} mayDecide busy={false} onDecide={onDecide} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: "A Project's default Verifier" })).toBeInTheDocument();
    expect(screen.getByText(/approved or denied as filed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve as requested' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve' }));
    expect(onDecide.mock.calls[0][0].editedChange ?? null).toBeNull();
    cleanup();
    render(<MemoryRouter><ChangeRequestDetail approval={item({ targetType: 'charter.revision', requested: { content: 'The Charter.', contentHash: 'abc' } })}
      mayDecide busy={false} onDecide={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'A Charter revision' })).toBeInTheDocument();
    expect(screen.getByText(/approved or denied as filed/)).toBeInTheDocument();
  });

  test('Ask for a different role files identity.role for the signed-in Account on the session door', async () => {
    const onFiled = vi.fn();
    replies = [{ match: (url, method) => url.endsWith('/approvals/requests') && method === 'POST', status: 202, body: { success: true, approval: { id: 'x' } } }];
    render(<MemoryRouter><RequestRoleChange principalId="p-me" onFiled={onFiled} /></MemoryRouter>);
    await userEvent.click(screen.getByText('Ask for a different role'));
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'editor');
    const ask = screen.getByRole('button', { name: 'Ask for this role' });
    expect(ask).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Reason/), 'I review the release notes every week now.');
    await userEvent.click(ask);
    await waitFor(() => expect(onFiled).toHaveBeenCalled());
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      targetType: 'identity.role', targetId: 'p-me', change: { role: 'editor' }, reason: 'I review the release notes every week now.',
    });
  });
});
