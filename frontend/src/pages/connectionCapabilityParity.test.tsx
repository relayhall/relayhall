/*
 * The two surfaces that talk about regenerating a credential must never
 * disagree (round-2 finding P3-R2).
 *
 * The wizard's lost-credential recovery sentence used to say "regenerate it"
 * unconditionally, while My connections DISABLES Regenerate for every non-root
 * session and tells Members to replace-and-disable instead. A day-one Member
 * who lost a response was therefore sent to do the one thing the next screen
 * refused them.
 *
 * This test renders BOTH surfaces, for the same session, and asserts they agree
 * with each other and with `mayRegenerateCredential`. It is deliberately not
 * two separate assertions against a constant: the failure being prevented is a
 * DISAGREEMENT, and only a test that looks at both can see one.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MyConnectionsPage } from './MyConnectionsPage';
import { ConnectAgentWizard } from '../components/connections/ConnectAgentWizard';
import {
  Connection, CONNECTION_TEMPLATES, RECOVERY_INTENT_PATTERN, mayRegenerateCredential,
} from '../types/connections';

/**
 * Regeneration/rotation intent, at WORD level.
 *
 * Round 3 defeated the previous matcher — the single exact phrase
 * `/regenerate its credential/` — by appending "…, or regenerate it" to an
 * otherwise-correct Member instruction: the required replacement phrase was
 * still present and both negatives missed the shorter wording. A detector that
 * only recognises one spelling of the thing it forbids is a detector that can
 * be talked around.
 */
const REGENERATION_INTENT = RECOVERY_INTENT_PATTERN;

const fetchMock = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const CONNECTION: Connection = {
  principalId: CONNECTOR_ID,
  handle: 'connector-laptop',
  displayName: 'Laptop',
  status: 'active',
  lastSeenAt: null,
  purpose: null,
  service: {
    id: 's1', slug: 'laptop', name: 'Laptop',
    description: CONNECTION_TEMPLATES[0].registrationText,
    status: 'draft', runtimeMode: 'direct', createdAt: null,
  },
  credentials: [{
    id: 'cred-1', keyId: 'rh_dev_public', label: 'Laptop', scopes: ['tasks:read'],
    transport: 'mcp', createdAt: null, expiresAt: null, revokedAt: null,
    lastUsedAt: null, graceUntil: null, revealCount: 0, revealable: true, state: 'live',
  }],
  agents: [],
};

const INSTRUCTIONS = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
  mcpConfig: { claudeCode: {}, codex: '[mcp_servers.relayhall]', generic: {} },
  cliEnv: [],
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '<paste your connection credential here>',
};

/**
 * The two ways a create can fail into a recovery instruction. Round 3 found the
 * probe only ever exercised the first, so the second shipped a contradicting
 * sentence for a whole round without any control noticing.
 */
type FailureShape = 'thrown' | 'no-pack';

/** Arms the board for a session holding exactly `scopes`. */
const armSession = (scopes: string[], opts: { failure?: FailureShape } = {}) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/principals/me')) {
      return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me', handle: 'ada', role: 'user' }, scopes }) };
    }
    if (target.endsWith('/principals/me/connectors')) {
      return { ok: true, status: 200, json: async () => ({ success: true, connectors: [CONNECTION], instructions: INSTRUCTIONS }) };
    }
    if (target.endsWith('/warrants')) {
      return { ok: true, status: 200, json: async () => ({ success: true, warrants: [] }) };
    }
    if (target.endsWith(`/principals/${CONNECTOR_ID}/grants`)) {
      return { ok: true, status: 200, json: async () => ({ success: true, grants: [] }) };
    }
    if (target.endsWith('/services') && init?.method === 'POST') {
      // 'thrown': the write may have committed and the reply was lost.
      if (opts.failure === 'thrown') throw new TypeError('Failed to fetch');
      // 'no-pack': the board answered 201 but returned no onboarding pack.
      return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' } }) };
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
};

/** Does My connections let this session press Regenerate? */
async function pageOffersRegenerate(scopes: string[]): Promise<boolean> {
  armSession(scopes);
  const view = render(<MemoryRouter><MyConnectionsPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Laptop' })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Regenerate credential/ })).toBeInTheDocument());
  const enabled = !(screen.getByRole('button', { name: /Regenerate credential/ }) as HTMLButtonElement).disabled;
  view.unmount();
  return enabled;
}

/** The wizard's recovery sentence for this session, under this failure shape. */
async function wizardRecoverySentence(scopes: string[], failure: FailureShape): Promise<string> {
  armSession(scopes, { failure });
  const view = render(<MemoryRouter><ConnectAgentWizard /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
  await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole('button', { name: /Next/ }));
  await userEvent.type(screen.getByLabelText('Name'), 'Laptop');
  await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  const sentence = screen.getByRole('alert').textContent ?? '';
  view.unmount();
  return sentence;
}

beforeEach(() => { fetchMock.mockReset(); });
afterEach(cleanup);

describe('the recovery sentence and the Regenerate control cannot disagree', () => {
  it.each([
    { who: 'a Member', scopes: ['tasks:read', 'tasks:write'], failure: 'thrown' as const },
    { who: 'a Member', scopes: ['tasks:read', 'tasks:write'], failure: 'no-pack' as const },
    { who: 'an administrator', scopes: ['root'], failure: 'thrown' as const },
    { who: 'an administrator', scopes: ['root'], failure: 'no-pack' as const },
  ])('agree for $who when the create fails as $failure', async ({ scopes, failure }) => {
    const predicate = mayRegenerateCredential(scopes);
    const controlEnabled = await pageOffersRegenerate(scopes);
    const sentence = await wizardRecoverySentence(scopes, failure);
    const sentenceSaysRegenerate = REGENERATION_INTENT.test(sentence);

    // Both surfaces agree with the predicate...
    expect(controlEnabled).toBe(predicate);
    expect(sentenceSaysRegenerate).toBe(predicate);
    // ...and therefore with each other, which is the property that was broken.
    expect(sentenceSaysRegenerate).toBe(controlEnabled);

    if (!predicate) {
      // A Member is told to do the thing the next screen actually offers, and
      // is not told to do the thing it refuses — in ANY wording.
      expect(sentence).toMatch(/connect a replacement agent/);
      expect(sentence).not.toMatch(REGENERATION_INTENT);
    }
  });

  it('CONTROL: the matcher catches SHORT wordings, not just the canonical phrase', () => {
    // The exact mutation round 3 used to defeat the previous matcher.
    expect(REGENERATION_INTENT.test('connect a replacement agent and disable this one, or regenerate it')).toBe(true);
    expect(REGENERATION_INTENT.test('rotate the credential')).toBe(true);
    expect(REGENERATION_INTENT.test('regeneration is an administrator act')).toBe(true);
    // ...and does not fire on unrelated prose, so it is not trivially true.
    expect(REGENERATION_INTENT.test('connect a replacement agent and disable this one')).toBe(false);
  });

  it('CONTROL: the matcher catches the round-4 synonyms that defeated it', () => {
    // The exact wording that left both this control and the census green.
    expect(REGENERATION_INTENT.test('…and disable this one, or issue a new credential')).toBe(true);
    expect(REGENERATION_INTENT.test('re-generate the credential')).toBe(true);
    expect(REGENERATION_INTENT.test('you can regen it')).toBe(true);
    expect(REGENERATION_INTENT.test('try rolling the credential')).toBe(true);
  });

  it('CONTROL: the two sessions genuinely differ, so agreement is not free', () => {
    // Without this, an implementation that always returned the same sentence
    // and always disabled the control would satisfy every assertion above.
    expect(mayRegenerateCredential(['tasks:read'])).toBe(false);
    expect(mayRegenerateCredential(['root'])).toBe(true);
    expect(mayRegenerateCredential(null)).toBe(false);
    expect(mayRegenerateCredential([])).toBe(false);
  });
});
