/*
 * The three-step Connect-your-agent wizard (card 653be44f; owner design record
 * 99d6b0ad §3.1 + decision 1).
 *
 * What is pinned here is the SHAPE OF THE CALL, not just the pixels: which
 * route the wizard uses, that the scopes it asks for are the session's own set
 * and no more, that the transport comes from the chosen template, and that the
 * registration text it writes is the exact string the list maps back. Those are
 * the facts a rewrite could break silently.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectAgentWizard } from './ConnectAgentWizard';
import {
  CONNECTION_TEMPLATES, CREDENTIAL_TOKEN_PATTERN, recommendedScopesFor,
} from '../../types/connections';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const REAL_TOKEN = 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000';
const SESSION_SCOPES = ['tasks:read', 'tasks:write', 'reports:read'];

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const refused = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload });

const PACK = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api. Authenticate with your credential and fetch everything else from it.',
  mcpConfig: {
    claudeCode: { mcpServers: { relayhall: { type: 'http', url: 'https://board.example/api/mcp', headers: { Authorization: 'Bearer rh_dev_ab12cd34ef56.SECRETVALUE0000000000' } } } },
    // The Codex snippet as the server composes it (`utils/onboardingPack.ts`):
    // it names an environment variable and carries NO credential, which is what
    // card `b68c48c1` is about.
    codex: '[mcp_servers.relayhall]\nurl = "https://board.example/api/mcp"\nbearer_token_env_var = "RELAYHALL_TOKEN"',
    generic: {
      transport: 'streamable-http',
      url: 'https://board.example/api/mcp',
      headers: { Authorization: 'Bearer rh_dev_ab12cd34ef56.SECRETVALUE0000000000' },
    },
  },
  cliEnv: ['export RELAYHALL_API_URL=https://board.example/api', 'export RELAYHALL_TOKEN=rh_dev_ab12cd34ef56.SECRETVALUE0000000000'],
  credential: { credentialId: 'c1', keyId: 'rh_dev_key', secretOnce: 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000', expiresAt: null, transport: 'mcp' },
  authoritySummary: { scopes: SESSION_SCOPES, rules: [] },
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '',
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/principals/me')) {
      return ok({ success: true, principal: { id: 'me', handle: 'ada', kind: 'human', role: 'user' }, scopes: SESSION_SCOPES });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(cleanup);

const renderWizard = () => render(<ConnectAgentWizard />);

describe('step 1 — what is it for', () => {
  it('offers exactly the six choices of the owner record, in its order', async () => {
    renderWizard();
    const group = screen.getByRole('radiogroup', { name: 'What the connection is for' });
    const rendered = within(group).getAllByRole('radio').map((node) => (node.textContent || '').trim());
    expect(rendered).toHaveLength(6);
    // Order is the owner record's own order, and each choice is the table's.
    CONNECTION_TEMPLATES.forEach((template, index) => {
      expect(rendered[index]).toContain(template.label);
    });
    expect(CONNECTION_TEMPLATES.map((t) => t.label)).toEqual(
      ['Claude Code', 'Codex', 'VS Code', 'Generic MCP client', 'API script', 'Messaging gateway'],
    );
  });

  it('disables the messaging gateway and says why, because no gateway surface exists yet', async () => {
    renderWizard();
    const gateway = screen.getByRole('radio', { name: /Messaging gateway/ });
    expect(gateway).toBeDisabled();
    expect(within(gateway).getByText('Coming with the gateway phase')).toBeInTheDocument();
  });

  it('states decision 1 in ONE sentence and offers the narrow-it disclosure', async () => {
    renderWizard();
    await waitFor(() => {
      expect(screen.getByText(
        'By default this connection can do everything you can do — narrow it here, or later in My connections.',
      )).toBeInTheDocument();
    });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    // The disclosure offers exactly the session's own scopes — the ceiling the
    // server will enforce — all of them ticked, which IS decision 1.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(SESSION_SCOPES.length);
    expect(boxes.every((box) => box.checked)).toBe(true);
  });
});

describe('a session whose authority resolves LATE (review finding P1)', () => {
  /** A `/principals/me` the test resolves by hand. */
  const deferredSession = () => {
    let resolve: (value: unknown) => void = () => undefined;
    const pending = new Promise((r) => { resolve = r; });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/principals/me')) return pending;
      throw new Error(`unexpected fetch: ${url}`);
    });
    return {
      answer: () => act(async () => {
        resolve(ok({ success: true, principal: { id: 'me', handle: 'ada', role: 'user' }, scopes: SESSION_SCOPES }));
        await Promise.resolve();
      }),
    };
  };

  it('opening narrow-it BEFORE the answer arrives still lands on decision 1', async () => {
    // The defect: opening the disclosure was what stopped the default from
    // tracking the session, so a slow /principals/me left every box unchecked
    // under a sentence promising the opposite — and the create call carried an
    // empty scope set that the board refuses with 422.
    const session = deferredSession();
    renderWizard();
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    // Nothing has been offered yet — the session has not answered.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await session.answer();

    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(SESSION_SCOPES.length));
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it('but a selection the person actually EDITED is never overwritten by a late answer', async () => {
    // The other direction, so the repair cannot be "always re-sync", which
    // would throw away a deliberate choice.
    const session = deferredSession();
    renderWizard();
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await session.answer();
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(SESSION_SCOPES.length));

    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    const afterEdit = (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked);
    expect(afterEdit.filter(Boolean)).toHaveLength(SESSION_SCOPES.length - 1);

    // A re-render carrying the same resolved scopes must not restore the box.
    await act(async () => { await Promise.resolve(); });
    const afterSettle = (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked);
    expect(afterSettle).toEqual(afterEdit);
  });
});

describe('the template recommendation (decision 1 stays the default)', () => {
  it('offers the template set inside narrow-it, and does NOT apply it on its own', async () => {
    renderWizard();
    await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));

    // Decision 1: the DEFAULT is still everything the person can do.
    const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes().every((b) => b.checked)).toBe(true);

    // The recommendation is an ACTION the person takes.
    await userEvent.click(screen.getByRole('button', { name: 'Use the recommended set for Claude Code' }));
    const ticked = boxes().filter((b) => b.checked).map((b) => b.id.replace('conn-wizard-scope-', ''));
    const expected = recommendedScopesFor(CONNECTION_TEMPLATES[0], SESSION_SCOPES)
      .map((s) => s.replace(/[^a-z0-9]+/gi, '-'));
    expect(ticked.sort()).toEqual(expected.sort());
  });

  it('the recommendation is INTERSECTED with the session — a template can only narrow', () => {
    // The session here holds three of the eight scopes the template names.
    const recommended = recommendedScopesFor(CONNECTION_TEMPLATES[0], SESSION_SCOPES);
    expect(recommended.length).toBeGreaterThan(0);
    expect(recommended.every((scope) => SESSION_SCOPES.includes(scope))).toBe(true);
    // The control can fire: the template genuinely names scopes this session
    // does NOT hold, so an unintersected implementation would differ here.
    expect(CONNECTION_TEMPLATES[0].suggestedScopes.some((s) => !SESSION_SCOPES.includes(s))).toBe(true);
    expect(recommendedScopesFor(CONNECTION_TEMPLATES[0], [])).toEqual([]);
  });

  it('every template recommends only scopes the board can actually mint', () => {
    // No `root`, no `:admin` family — a role-derived Member session holds
    // neither, so a template naming one could only ever produce a refusal.
    for (const template of CONNECTION_TEMPLATES) {
      expect(template.suggestedScopes.length).toBeGreaterThan(0);
      for (const scope of template.suggestedScopes) {
        expect(scope).not.toBe('root');
        expect(scope.endsWith(':admin')).toBe(false);
      }
    }
  });
});

describe('creating the connection', () => {
  const walkToCreate = async (templateName: RegExp = /Claude Code/) => {
    renderWizard();
    await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: templateName }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'My Laptop');
  };

  it('registers and issues in ONE call on the self-service route, with the template transport and the session scopes', async () => {
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    const call = fetchMock.mock.calls.find(([url, init]: any[]) => String(url).endsWith('/services') && init?.method === 'POST')!;
    expect(call).toBeDefined();
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.kind).toBe('connector');
    expect(body.slug).toBe('my-laptop');
    expect(body.name).toBe('My Laptop');
    // The exact string the list maps back through the same table.
    expect(body.description).toBe(CONNECTION_TEMPLATES[0].registrationText);
    expect(body.issueCredential.transport).toBe('mcp');
    expect(body.issueCredential.scopes).toEqual(SESSION_SCOPES);
    // Nothing that would ask for authority beyond the session, and no owner
    // other than the caller: the route refuses both, and the wizard never tries.
    expect(body.ownerAccountId).toBeUndefined();
  });

  it('shows the one-time credential in step 3, in the tab the template chose, and says it is shown once', async () => {
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => {
      expect(screen.getByText('Paste this into your agent and let it configure itself.')).toBeInTheDocument();
    });
    expect(screen.getByText(/shown once and is never stored on the board/)).toBeInTheDocument();
    // The Claude Code tab is selected and its block carries the real token.
    expect(screen.getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(new RegExp(REAL_TOKEN))).toBeInTheDocument();
    // The fixture is a REAL-SHAPED token, so the leak controls elsewhere are
    // matching the grammar the board actually mints.
    expect(CREDENTIAL_TOKEN_PATTERN.test(REAL_TOKEN)).toBe(true);
  });

  it('each admitted tab renders ITS OWN block, taken from the pack and not assembled here', async () => {
    // Author-found gap N1: only the tab a template opens on was ever asserted,
    // so a blockFor() that returned the wrong harness's configuration shipped
    // green — and rendering the pack faithfully is this pane's whole claim.
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByText(/Paste this into your agent/)).toBeInTheDocument());

    const block = () => document.querySelector('.conn-copyblock-body')!.textContent ?? '';
    // Claude Code is the template's tab and is already selected.
    expect(block()).toBe(JSON.stringify(PACK.mcpConfig.claudeCode, null, 2));

    await userEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(block()).toBe(PACK.mcpConfig.codex);

    await userEvent.click(screen.getByRole('radio', { name: 'Generic MCP client' }));
    expect(block()).toBe(JSON.stringify(PACK.mcpConfig.generic, null, 2));

    // The three blocks are genuinely different, so the assertions above cannot
    // all be satisfied by one constant.
    const distinct = new Set([
      JSON.stringify(PACK.mcpConfig.claudeCode, null, 2),
      PACK.mcpConfig.codex,
      JSON.stringify(PACK.mcpConfig.generic, null, 2),
    ]);
    expect(distinct.size).toBe(3);
  });

  /**
   * CARD b68c48c1 — every ENABLED tab has to be completable on its own.
   *
   * The Codex tab renders that harness's correct shape: a `config.toml` block
   * naming `bearer_token_env_var = "RELAYHALL_TOKEN"` and carrying no secret.
   * Nothing on the tab said what to export, and the credential is shown exactly
   * once — so a person who landed there could not finish without reading a
   * different tab.
   *
   * WHY THE EXPECTED COUNTS ARE WRITTEN OUT rather than derived. A count taken
   * from the rendered page would be satisfied by whatever the page happens to
   * do, which is the assertion-shaped nothing this suite keeps being repaired
   * for. Each number below is a review decision: how many times a person should
   * meet the credential on that tab, and why.
   */
  const TOKEN_SIGHTINGS: Record<string, number> = {
    // The `Authorization` header inside the one JSON config block.
    'Claude Code': 1,
    // NOT in the TOML — asserted separately below — and once per shell form in
    // the block underneath it, because `export` is a syntax error in PowerShell
    // and a Windows reader would otherwise translate a credential by hand.
    Codex: 2,
    'Generic MCP client': 1,
    // The pack's own `export RELAYHALL_TOKEN=` line.
    'CLI and scripts': 1,
  };

  /** Every copy block currently on screen, as one string per block. */
  const blocks = () => Array.from(document.querySelectorAll('.conn-copyblock-body'))
    .map((node) => node.textContent ?? '');
  const sightings = (text: string) => text.split(REAL_TOKEN).length - 1;

  it('every ENABLED tab surfaces the credential literal, and the Codex TOML still does not', async () => {
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByText(/Paste this into your agent/)).toBeInTheDocument());

    // The Claude Code template pins `mcp`, so these three are the enabled tabs.
    for (const label of ['Claude Code', 'Codex', 'Generic MCP client']) {
      await userEvent.click(screen.getByRole('radio', { name: label }));
      const seen = blocks().reduce((total, text) => total + sightings(text), 0);
      expect(`${label}: ${seen}`).toBe(`${label}: ${TOKEN_SIGHTINGS[label]}`);
    }

    // THE DEFECT, stated: on Codex the literal is in a block of its own and the
    // config file stays free of it — which is the whole reason that tab defers
    // to a variable in the first place.
    await userEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    const [toml, env] = blocks();
    expect(toml).toBe(PACK.mcpConfig.codex);
    expect(toml).not.toContain(REAL_TOKEN);
    expect(CREDENTIAL_TOKEN_PATTERN.test(toml)).toBe(false);
    expect(env).toBe(`export RELAYHALL_TOKEN=${REAL_TOKEN}\n$env:RELAYHALL_TOKEN = "${REAL_TOKEN}"`);
    // The variable the two blocks agree on is the one Codex was told to read.
    expect(toml).toContain('bearer_token_env_var = "RELAYHALL_TOKEN"');
    // Its own copy button, and the same one-time warning covering both blocks.
    expect(screen.getByRole('button', { name: 'Copy the RELAYHALL_TOKEN lines' })).toBeInTheDocument();
    expect(screen.getByText(/shown once and is never stored on the board/)).toBeInTheDocument();
  });

  it('the CLI tab — the other enabled shape — surfaces it too', async () => {
    // The remaining tab of `TOKEN_SIGHTINGS`, reached the only way the wizard
    // can reach it: an `api` pin, where the three MCP tabs are the dark ones.
    await walkToCreate(/API script/);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'CLI and scripts' })).toBeEnabled());

    const seen = blocks().reduce((total, text) => total + sightings(text), 0);
    expect(seen).toBe(TOKEN_SIGHTINGS['CLI and scripts']);
    // And the Codex env block is a CODEX thing, not something bolted onto every
    // tab: nothing here offers to set the variable.
    expect(screen.queryByRole('button', { name: 'Copy the RELAYHALL_TOKEN lines' })).not.toBeInTheDocument();
  });

  it('CONTROL: the sighting counter can read zero, so the arms above are measurements', async () => {
    // A counter that could never return 0 would make every assertion above true
    // by construction. This is the same function against the one block that
    // deliberately carries no credential.
    expect(sightings(PACK.mcpConfig.codex)).toBe(0);
    expect(sightings(`Authorization: Bearer ${REAL_TOKEN}`)).toBe(1);
  });

  it('an mcp-pinned connection disables the CLI tab and names the reason, rather than handing out a snippet that would be refused', async () => {
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'CLI and scripts' })).toBeInTheDocument());
    const cliTab = screen.getByRole('radio', { name: 'CLI and scripts' });
    expect(cliTab).toBeDisabled();
    expect(cliTab).toHaveAttribute('title', expect.stringContaining('pinned to the mcp transport'));
  });

  it('an API script pins api, and the MCP tabs are the ones that go dark', async () => {
    await walkToCreate(/API script/);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.issueCredential.transport).toBe('api');
        return { ok: true, status: 201, json: async () => ({ success: true, service: { id: 's1' }, onboarding: PACK }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'CLI and scripts' })).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Claude Code' })).toBeDisabled();
  });

  it('names each refusal the route actually emits, in the person words', async () => {
    await walkToCreate();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return refused(403, { code: 'ISSUE_EXCEEDS_SESSION', message: 'requested credential scopes exceed the session' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('That is more authority than you hold yourself');
    });
    // The step did not advance: nothing was created, and no pack is shown.
    expect(screen.queryByText('Paste this into your agent and let it configure itself.')).not.toBeInTheDocument();
  });

  it.each(['Board', 'board', 'BOARD'])('refuses the RESERVED name %s in the form, never at the server', async (typed) => {
    // Round-4 finding P-R4-REBASE: the board reserves this slug in
    // `validateSlug`, but the form used to call it usable, enable Create, and
    // let the person collect a 422. Every casing slugifies to `board`.
    renderWizard();
    await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), typed);

    expect(screen.getByRole('button', { name: 'Create connection' })).toBeDisabled();
    expect(screen.getByText(/is a name the board keeps for itself/)).toBeInTheDocument();
    // ...and nothing was sent: the refusal is the form's, not the board's.
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith('/services'))).toBe(false);
  });

  it('names the RESERVED_SERVICE_SLUG refusal if the board ever returns it', async () => {
    // The form refuses reserved names first, so this is the belt to that
    // brace: if the board's reserved set grows past the mirror, the person
    // still gets a sentence rather than a raw server string.
    renderWizard();
    await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ledger');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/principals/me')) return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES });
      if (String(url).endsWith('/services') && init?.method === 'POST') {
        return refused(422, { code: 'RESERVED_SERVICE_SLUG', message: "slug 'ledger' is reserved" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('That name is one the board keeps for itself. Pick another.');
    });
  });

  it('refuses a name the board could never turn into an address, in the form rather than at the server', async () => {
    renderWizard();
    await waitFor(() => expect(screen.getByText(/everything you can do/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), '???');
    expect(screen.getByRole('button', { name: 'Create connection' })).toBeDisabled();
    expect(screen.getByText(/no letters or digits the board can turn into an address/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith('/services'))).toBe(false);
  });
});
