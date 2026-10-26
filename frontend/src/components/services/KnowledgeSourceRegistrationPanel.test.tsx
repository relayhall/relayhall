// @vitest-environment jsdom
/**
 * Card 08792425 (member N6, the core half of two-way registration): the
 * Services page panel. The board is a double here (authenticatedFetch); the
 * live backend suite knowledgeSourceRegistrationLive measures the routes these
 * call, and the board decides every act again.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { KnowledgeSourceRegistrationPanel } from './KnowledgeSourceRegistrationPanel';
import { displayFingerprint, normalizeFingerprint, previewBundle } from '../../utils/knowledgeSourceRegistrationApi';

const calls = vi.hoisted(() => ({ list: [] as Array<{ url: string; init?: RequestInit }>, routes: {} as Record<string, () => Response> }));
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.list.push({ url, init });
    const method = init?.method ?? 'GET';
    const handler = calls.routes[`${method} ${url}`];
    return handler ? handler() : new Response(JSON.stringify({ code: 'NOT_STUBBED' }), { status: 500 });
  }),
}));
vi.mock('../access/StepUpDialog', () => ({
  StepUpDialog: ({ action, targetId, onToken }: any) => <button onClick={() => onToken('rhsu_test_token')}>Confirm {action} {targetId}</button>,
}));

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const LIST = 'GET /api/knowledge-source-registrations';
const FINGERPRINT = '0123456789abcdef'.repeat(4);
const SERVICE_ID = '11111111-2222-4333-8444-555555555555';
const BUNDLE = {
  schema: 'rh.knowledge-source.registration/1', name: 'Team knowledge', endpoint: 'https://knowledge.example.org/knowledge/search',
  descriptor: { options: [], knowledgeSource: { classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2, compartment_mode: 'dynamic-opaque', categories: ['note'] } },
  certificateSha256: displayFingerprint(FINGERPRINT),
};

function state(resolves: boolean) {
  return {
    schemaVersion: 'rh.knowledge-source.registration-state/1',
    service: { id: SERVICE_ID, slug: 'team-knowledge', name: 'Team knowledge', status: 'published', currentDescriptorVersion: 1 },
    endpoints: { query: BUNDLE.endpoint, get: null, write: null, allowedNetworks: [] },
    fingerprint: { sha256: FINGERPRINT, display: displayFingerprint(FINGERPRINT), confirmation: 'checked', confirmedBy: 'p1', confirmedAt: '2026-10-21T12:00:00.000Z' },
    channel: {
      credentialReference: 'knowledge-source/team-knowledge', environmentVariable: 'RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS',
      resolves, dial: resolves ? 'ready' : 'refused', refusal: resolves ? null : 'unavailable:transport',
    },
    operatorSteps: [
      { id: 'place-channel-bearer', done: resolves, text: 'On the core host, as root: add an entry named "knowledge-source/team-knowledge" to the JSON in RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS.' },
      { id: 'restart-core', done: resolves, text: 'Restart the core so it reads the new environment.' },
    ],
    lifecycleExport: { configured: false, keyRecorded: false },
    assertionKeysConfigured: true,
    grantsForApproval: {
      scope: 'knowledge-contents:read', targetType: 'grant.rows', decidedOn: '/approvals',
      change: { rules: [{ resourceType: 'service', selectorForm: 'exact', selectorIds: [SERVICE_ID], verbs: ['read'] }] },
    },
  };
}
const RETURN_BUNDLE = {
  schema: 'rh.knowledge-source.return/1', serviceId: SERVICE_ID, audience: SERVICE_ID, issuer: 'https://board.example.org',
  certificateSha256: FINGERPRINT, credentialReference: 'knowledge-source/team-knowledge',
  assertionKeys: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'k1', alg: 'EdDSA', use: 'sig' }] }, lifecycleKey: null,
};

function renderPanel() {
  return render(<MemoryRouter><KnowledgeSourceRegistrationPanel /></MemoryRouter>);
}

beforeEach(() => { calls.list = []; calls.routes = {}; });
afterEach(cleanup);

test('the fingerprint helpers normalize what an installer prints and read a pasted bundle', () => {
  expect(normalizeFingerprint(displayFingerprint(FINGERPRINT))).toBe(FINGERPRINT);
  expect(normalizeFingerprint(`SHA256 Fingerprint=${displayFingerprint(FINGERPRINT)}`)).toBe(FINGERPRINT);
  expect(normalizeFingerprint('nope')).toBeNull();
  expect(previewBundle('{')).toEqual({ ok: false, message: expect.stringContaining('not valid JSON') });
  expect(previewBundle(JSON.stringify({ ...BUNDLE, schema: 'other' }))).toMatchObject({ ok: false });
  expect(previewBundle(JSON.stringify(BUNDLE))).toMatchObject({ ok: true, preview: { fingerprint: FINGERPRINT, protocolVersion: 2, name: 'Team knowledge' } });
});

test('a session the board refuses is told who may register and is offered no form', async () => {
  calls.routes[LIST] = json({ code: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR', message: 'no' }, 403);
  renderPanel();
  expect(await screen.findByText(/for root or an administrator/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Registration bundle/)).toBeNull();
});

test('registering: the fingerprint is shown, must be ticked, and the step-up is bound to (knowledge.source.register, the fingerprint)', async () => {
  let registered = false;
  calls.routes[LIST] = () => json({ success: true, registrations: registered ? [state(false)] : [] })();
  calls.routes['POST /api/knowledge-source-registrations'] = () => {
    registered = true;
    return json({ success: true, registration: state(false), returnBundle: RETURN_BUNDLE }, 201)();
  };
  renderPanel();
  expect(await screen.findByText('No knowledge source has been registered from a bundle yet.')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/Registration bundle/), { target: { value: '{"broken"' } });
  expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON');

  fireEvent.change(screen.getByLabelText(/Registration bundle/), { target: { value: JSON.stringify(BUNDLE) } });
  expect(screen.getByText(displayFingerprint(FINGERPRINT))).toBeInTheDocument();
  const register = screen.getByRole('button', { name: 'Register' });
  expect(register).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Allowed networks/), { target: { value: '100.64.0.0/24, 100.64.1.0/24' } });
  fireEvent.click(screen.getByLabelText(/I compared this fingerprint/));
  expect(register).toBeEnabled();
  fireEvent.click(register);
  fireEvent.click(await screen.findByRole('button', { name: `Confirm knowledge.source.register ${FINGERPRINT}` }));

  await screen.findByText(/Team knowledge is registered/);
  const post = calls.list.find((entry) => entry.init?.method === 'POST')!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    bundle: BUNDLE, confirmedFingerprint: FINGERPRINT, confirmation: 'checked',
    allowedNetworks: ['100.64.0.0/24', '100.64.1.0/24'], stepUpToken: 'rhsu_test_token',
  });

  // The registered source, honestly: waiting for the operator, by name, never a value.
  const card = await screen.findByRole('article', { name: 'Team knowledge' });
  expect(within(card).getByText(/Waiting for the operator/)).toBeInTheDocument();
  expect(within(card).getByText('unavailable:transport')).toBeInTheDocument();
  expect(within(card).getByText(/add an entry named "knowledge-source\/team-knowledge"/)).toBeInTheDocument();
  expect(within(card).getByText(/does not pin it/)).toBeInTheDocument();
  // The read grant is made on Access grants. No change-request button: the
  // board refuses that filing ALREADY_HELD today (the live backend suite pins it).
  expect(within(card).getByRole('link', { name: 'Access grants' })).toHaveAttribute('href', '/settings/access');
  expect(within(card).getByText(/An operator cannot make it there/)).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: 'Request a change' })).toBeNull();
});

test('a changed fingerprint clears the tick: confirming one certificate never confirms another', async () => {
  calls.routes[LIST] = json({ success: true, registrations: [] });
  renderPanel();
  const box = await screen.findByLabelText(/Registration bundle/);
  fireEvent.change(box, { target: { value: JSON.stringify(BUNDLE) } });
  fireEvent.click(screen.getByLabelText(/I compared this fingerprint/));
  expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled();
  fireEvent.change(box, { target: { value: JSON.stringify({ ...BUNDLE, certificateSha256: 'ff'.repeat(32) }) } });
  await waitFor(() => expect(screen.getByLabelText(/I compared this fingerprint/)).not.toBeChecked());
  expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
});

test('a refusal is shown by its code and its own sentence', async () => {
  calls.routes[LIST] = json({ success: true, registrations: [] });
  calls.routes['POST /api/knowledge-source-registrations'] = json({ code: 'REGISTRATION_ENDPOINT_TAKEN', message: 'A registered knowledge source already uses this endpoint' }, 409);
  renderPanel();
  fireEvent.change(await screen.findByLabelText(/Registration bundle/), { target: { value: JSON.stringify(BUNDLE) } });
  fireEvent.click(screen.getByLabelText(/I compared this fingerprint/));
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  fireEvent.click(await screen.findByRole('button', { name: `Confirm knowledge.source.register ${FINGERPRINT}` }));
  expect(await screen.findByText(/Refused \(REGISTRATION_ENDPOINT_TAKEN\): A registered knowledge source already uses this endpoint/)).toBeInTheDocument();
});

test('the return bundle is read from the board and copied; a resolved reference never claims a connection', async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  calls.routes[LIST] = json({ success: true, registrations: [state(true)] });
  calls.routes[`GET /api/knowledge-source-registrations/${SERVICE_ID}/return-bundle`] = json(RETURN_BUNDLE);
  renderPanel();
  const card = await screen.findByRole('article', { name: 'Team knowledge' });
  expect(within(card).getByText('Channel credential in place.')).toBeInTheDocument();
  expect(within(card).queryByText(/Connected/)).toBeNull();
  expect(within(card).getByText(/must chain to a public certificate authority/)).toBeInTheDocument();
  expect(within(card).getByText(/not yet a successful connection/)).toBeInTheDocument();
  expect(within(card).queryByText(/Waiting for the operator/)).toBeNull();
  fireEvent.click(within(card).getByRole('button', { name: 'Copy the return bundle' }));
  await screen.findByText(/Return bundle copied/);
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(RETURN_BUNDLE);
});
