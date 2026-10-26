/*
 * THE ADMINISTRATOR ARM OF THE DAY-ONE WIZARD (cards 6e25ae48 and 07d09eaf).
 *
 * THE FIRST DEFECT (6e25ae48): `scopesForRole` returns `['root']` for `admin`
 * and `orchestrator` — the two roles a fresh deployment can possibly be
 * administered by — the wizard offered the caller's own effective set as its
 * menu and its default, and `PrincipalService.issueCredential` refuses `root`
 * outright (AUTHZ §5.2 rule 2 / AZ-18). So the headline flow on the dashboard
 * of a fresh install returned HTTP 500 to the only person able to run it, and
 * the *narrow it* panel offered exactly one box: the one scope certain to be
 * refused. The repair made the MENU the server's `delegableScopes`.
 *
 * THE SECOND DEFECT (07d09eaf), and why this file's expectations moved: the
 * repair also made the administrator DEFAULT the step-1 template's working set
 * (declared amendment UX-A1). A credential carrying only that set cannot
 * bootstrap. Every work-plane MCP tool stays closed until the credential calls
 * `relayhall_brief_compile {session: true}`; that call needs `principals:read`;
 * no template working set names it. The 500 became a 403 and the day-one flow
 * was still a dead end. The owner ruled the DEFAULT on 2026-09-07: a new
 * connection starts with the whole delegable catalogue, on every arm and for
 * every template, and narrowing is a later act. The template set survives as a
 * one-click hint.
 *
 * ── WHAT THIS FILE MEASURES, AND WHY IN THIS ARRANGEMENT ──
 *
 * The property is not "the wizard renders differently for an admin". It is
 * `root` NEVER LEAVES THIS COMPONENT — not in the menu, not in the default, and
 * above all not in the body of `POST /services` — and, since the ruling, that
 * everything ELSE the board says is delegable does. The assertions are on the
 * REQUEST the wizard makes, read out of the fetch mock, because that is the
 * only place either defect was observable: every pixel on step 1 looked
 * reasonable while the call carried `['root']`, and looked equally reasonable
 * while it carried a set that could not bootstrap.
 *
 * The session is driven through `authenticatedFetch` rather than by mocking
 * `useMyPrincipal`, because the source of truth is the SERVER's
 * `delegableScopes` field on `GET /principals/me`. Mocking the hook would test
 * a fixture; mocking the response tests the seam that carries the field.
 *
 * ── THE CONTROLS, EACH REDDENING A DIFFERENT ASSERTION ──
 *
 * A default asserted only as "the whole delegable set" is satisfied by a wizard
 * that ignores the board and ticks every box it can find, so the menu is
 * asserted to be exactly the server's answer and to exclude `root`. An
 * assertion made only on screen is satisfied by a wizard that offers the right
 * menu and posts the wrong body, so the posted body is asserted separately. And
 * a file that watched only the administrator would not notice a wizard that
 * threw decision 1 away for the Members it already worked for, so the non-root
 * arm is measured from the same fixtures.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectAgentWizard } from './ConnectAgentWizard';
import { AGENT_WORKING_SCOPES, API_SCRIPT_SCOPES, HARNESS_CONNECTOR_SCOPES } from '../../types/connections';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

/**
 * What the board answers an administrator: `scopes` is what the session may
 * REACH, `delegableScopes` what it may hand to a credential. The list is the
 * server's `MINTABLE_SCOPES` minus `root`; a short, representative slice is
 * enough here, and the full set is measured against the real catalogue in
 * `backend/src/__tests__/delegableScopes.test.ts` — this file must not become a
 * second copy of that catalogue, because a copy is a thing that rots.
 */
const ADMIN_DELEGABLE = [
  'tasks:read', 'tasks:write', 'tasks:admin',
  'projects:read', 'phases:read',
  'reports:read', 'reports:write',
  'skills:read', 'skills:use',
  'principals:read', 'principals:admin', 'audit:read',
];

/**
 * The scope card `07d09eaf` is about: `relayhall_brief_compile {session: true}`
 * required it then (card 1118fefa has since made that call a self-identity
 * read), and no template working set names it. It is in the fixture above so
 * "the default is the delegable catalogue" is a claim with teeth here — a
 * wizard that fell back to the template set would visibly drop this one.
 */
const BOOTSTRAP_SCOPE = 'principals:read';

const MEMBER_SCOPES = ['tasks:read', 'tasks:write', 'reports:read'];

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const refused = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload });

const PACK = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
  mcpConfig: { claudeCode: {}, codex: '', generic: {} },
  cliEnv: ['export RELAYHALL_API_URL=https://board.example/api'],
  credential: {
    credentialId: 'c1', keyId: 'rh_dev_key',
    secretOnce: 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000',
    expiresAt: null, transport: 'mcp',
  },
  authoritySummary: { scopes: AGENT_WORKING_SCOPES, rules: [] },
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '',
};

/** The `POST /services` bodies the wizard sent, in order. */
const posted: any[] = [];

/**
 * Arrange one session. `serviceAnswer` lets a single test replace the create
 * response with a refusal without restating the whole mock.
 */
function session(options: {
  role: string;
  scopes: string[];
  delegableScopes?: string[];
  serviceAnswer?: () => any;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/principals/me')) {
      return ok({
        success: true,
        principal: { id: 'me', handle: 'ada', kind: 'human', role: options.role },
        scopes: options.scopes,
        ...(options.delegableScopes ? { delegableScopes: options.delegableScopes } : {}),
      });
    }
    if (target.endsWith('/services')) {
      posted.push(JSON.parse(String(init?.body ?? '{}')));
      return options.serviceAnswer ? options.serviceAnswer() : ok({ success: true, service: { id: 's1' }, onboarding: PACK });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
}

/** Walk the wizard to a created connection under the named template. */
async function connect(templateLabel: string, name: string) {
  await userEvent.click(screen.getByRole('radio', { name: new RegExp(templateLabel) }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
}

/**
 * The scope boxes, read the way a person reads them: the label text IS the
 * scope, because `ScopeNarrowing` renders no `value` attribute. Going through
 * the rendered label rather than an id keeps this file honest about what is on
 * screen instead of about a naming convention.
 */
const scopeBoxes = () => screen.getAllByRole('checkbox').map((node) => ({
  input: node as HTMLInputElement,
  scope: (node.closest('label')?.textContent || '').trim(),
}));
const offeredScopes = () => scopeBoxes().map((box) => box.scope);
const checkedScopes = () => scopeBoxes().filter((box) => box.input.checked).map((box) => box.scope);
const boxFor = (scope: string) => scopeBoxes().find((box) => box.scope === scope)!.input;

beforeEach(() => {
  fetchMock.mockReset();
  posted.length = 0;
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(cleanup);

describe('an administrator completes the wizard (cards 6e25ae48, 07d09eaf)', () => {
  it('never asks the board for `root`, and asks for everything else it may delegate', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);

    await connect('Generic MCP client', 'Laptop');
    await waitFor(() => expect(posted).toHaveLength(1));

    const requested: string[] = posted[0].issueCredential.scopes;
    // DEFECT ONE, stated as an assertion: the body carried `['root']`, which is
    // the one scope issuance refuses, and the flow ended in a 500.
    expect(requested).not.toContain('root');
    expect(requested.length).toBeGreaterThan(0);
    // DEFECT TWO, stated as an assertion: the body carried the template working
    // set, which cannot bootstrap. The ruled default is the whole delegable
    // catalogue — the board's own answer, not a list this file chose.
    expect(requested.sort()).toEqual([...ADMIN_DELEGABLE].sort());
    expect(requested).toContain(BOOTSTRAP_SCOPE);
    // The control can fire: the catalogue genuinely holds scopes the template
    // set does not, so an implementation that kept the old default differs here.
    expect(AGENT_WORKING_SCOPES).not.toContain(BOOTSTRAP_SCOPE);

    // The flow actually completes: step 3, with the one-time pack.
    expect(await screen.findByText('Set up Laptop')).toBeInTheDocument();
  });

  it('the default does NOT follow the template any more — the ruling, on a second template', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);

    await connect('API script', 'CI runner');
    await waitFor(() => expect(posted).toHaveLength(1));
    // A different template, the SAME default — and still never `root`.
    expect(posted[0].issueCredential.scopes.sort()).toEqual([...ADMIN_DELEGABLE].sort());
    expect(posted[0].issueCredential.scopes).not.toContain('root');
    // Not vacuous: this template's own working set is a different, smaller list.
    expect([...API_SCRIPT_SCOPES].sort()).not.toEqual([...ADMIN_DELEGABLE].sort());
  });

  it('offers the delegable menu, with no `root` box in it, all of it ticked', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));

    // The default is the ceiling on this arm now, so the control only narrows —
    // and says so. It read "Choose what it can do" while UX-A1 made the default
    // a working set the control could widen.
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));

    expect(offeredScopes()).toHaveLength(ADMIN_DELEGABLE.length);
    expect(offeredScopes()).not.toContain('root');
    expect(checkedScopes().sort()).toEqual([...ADMIN_DELEGABLE].sort());
    expect(screen.getByText(
      `This connection will be able to do ${ADMIN_DELEGABLE.length} of the ${ADMIN_DELEGABLE.length} things a connection can be given.`,
    )).toBeInTheDocument();
  });

  it('the template working set survives as a HINT the person applies themselves', async () => {
    // The ruling moved the default; it did not delete the recommendation. A
    // repair that dropped the hint would leave an administrator with no
    // one-click way back to a narrow, purpose-shaped credential.
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(offeredScopes()).toHaveLength(ADMIN_DELEGABLE.length));

    await userEvent.click(screen.getByRole('button', { name: 'Use the recommended set for Generic MCP client' }));
    const expected = AGENT_WORKING_SCOPES.filter((scope) => ADMIN_DELEGABLE.includes(scope));
    expect(checkedScopes().sort()).toEqual([...expected].sort());
    // And it is genuinely narrower than the default, so the click did something.
    expect(expected.length).toBeLessThan(ADMIN_DELEGABLE.length);
  });

  it('a deliberate edit still owns the selection when the template changes', async () => {
    // The `chooseScopes` funnel (card 7f6d7635 T1-R2) is the reason the default
    // may track a late answer at all. The template is no longer an input to the
    // default, so this arm is now the weaker of the pair — the funnel's real
    // control is the late-authority one in `ConnectAgentWizard.scopeFunnel`.
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(offeredScopes()).toHaveLength(ADMIN_DELEGABLE.length));

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await userEvent.click(boxFor('audit:read'));
    expect(checkedScopes()).toEqual(['audit:read']);

    await userEvent.click(screen.getByRole('radio', { name: /API script/ }));
    expect(checkedScopes()).toEqual(['audit:read']);
  });

  it('CONTROL: before any edit, the default is the catalogue whatever the template says', async () => {
    // The mirror of the test above, and the ruling's own statement: switching
    // the step-1 choice must NOT rewrite an authority the person has read.
    session({ role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(checkedScopes().length).toBe(ADMIN_DELEGABLE.length));

    await userEvent.click(screen.getByRole('radio', { name: /API script/ }));
    await waitFor(() => expect(checkedScopes().sort()).toEqual([...ADMIN_DELEGABLE].sort()));
  });

  it('names the ROOT_NOT_MINTABLE refusal instead of falling through to the generic sentence', async () => {
    // Unreachable from the wizard now, and enumerated anyway: an enumerated
    // refusal table written only for reachable codes is a generic 500 waiting
    // for the day one of them becomes reachable again.
    session({
      role: 'admin', scopes: ['root'], delegableScopes: ADMIN_DELEGABLE,
      serviceAnswer: () => refused(422, {
        error: 'Refused', code: 'ROOT_NOT_MINTABLE',
        message: 'root is never delegable to a bearer credential (design 4d961e37 §5.2 rule 2 / AZ-18)',
      }),
    });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await connect('Generic MCP client', 'Laptop');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your own authority is never given to a connection.');
    expect(alert).not.toHaveTextContent('The board refused the request. Nothing was created.');
    // The server's own sentence is never rendered raw — the table exists so a
    // server-side rewording cannot change what a person reads.
    expect(alert).not.toHaveTextContent('4d961e37');
  });
});

describe('CONTROL — a Member session is untouched by either repair', () => {
  it('keeps owner decision 1: everything you can do, selected, in its own words', async () => {
    session({ role: 'user', scopes: MEMBER_SCOPES, delegableScopes: MEMBER_SCOPES });
    render(<ConnectAgentWizard />);
    await waitFor(() => {
      expect(screen.getByText(/^By default this connection can do everything you can do/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    expect(offeredScopes()).toHaveLength(MEMBER_SCOPES.length);
    expect(scopeBoxes().every((box) => box.input.checked)).toBe(true);
  });

  it('a Member gets only what is delegable to THEM, never the administrator catalogue', async () => {
    // The ruling widened the default; it did not widen the ceiling. The menu, the
    // ticks and the posted body are all the Member's own delegable set, and the
    // scope the day-one card is about is absent because the board never offered
    // it to this session.
    session({ role: 'user', scopes: MEMBER_SCOPES, delegableScopes: MEMBER_SCOPES });
    render(<ConnectAgentWizard />);
    await screen.findByText(/everything you can do/);
    await connect('Generic MCP client', 'Laptop');
    await waitFor(() => expect(posted).toHaveLength(1));

    const requested: string[] = posted[0].issueCredential.scopes;
    expect(requested.sort()).toEqual([...MEMBER_SCOPES].sort());
    expect(requested).not.toContain(BOOTSTRAP_SCOPE);
    expect(requested).not.toContain('principals:admin');
    expect(requested).not.toContain('audit:read');
    // Not vacuous: the administrator fixture in this same file DOES carry all
    // three, so "a Member gets less" is measured against a set that has more.
    expect(ADMIN_DELEGABLE).toContain(BOOTSTRAP_SCOPE);
    expect(ADMIN_DELEGABLE).toContain('principals:admin');
  });
});

describe('CONTROL — a board that answers no delegable set', () => {
  it('still never offers `root`, and never posts it', async () => {
    // The field is new. If a frontend ever runs against a board that predates
    // it, the fallback must fail SAFE — drop `root` from the caller's own set —
    // rather than posting the one scope certain to be refused.
    session({ role: 'admin', scopes: ['root', 'tasks:read'] });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    expect(offeredScopes()).toEqual(['tasks:read']);
  });
});

/**
 * THE HARNESS ARM (E462 slice S1; universal harness connector design v1.5
 * section 3.1). Claude Code, Codex, VS Code and Antigravity make ONE token with
 * the harness scope set, and the request that makes it also carries the first
 * descriptor. The assertions are on the REQUEST, as everywhere in this file: a
 * menu that looks right while the body asks for `tasks:admin` is the defect.
 */
describe('a harness template makes the one-token harness connector (E462 S1)', () => {
  /** An administrator who may delegate far more than a harness token carries. */
  const FULL_DELEGABLE = [
    ...ADMIN_DELEGABLE, 'telemetry:write', 'services:read', 'services:write', 'services:admin',
    'blueprints:read', 'blueprints:write', 'blueprints:use',
    'personalities:read', 'personalities:write', 'knowledge-contents:read', 'knowledge-contents:write',
    // E480: the two write verbs the harness set now carries, and their :admin neighbours, which it never does.
    'projects:write', 'projects:admin', 'phases:write', 'phases:admin',
  ];
  const HARNESS_EXPECTED = HARNESS_CONNECTOR_SCOPES.filter((scope) => FULL_DELEGABLE.includes(scope));

  const TOKEN = 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000';
  const TOKEN_PACK = {
    ...PACK,
    cliEnv: ['export RELAYHALL_API_URL=https://board.example/api', `export RELAYHALL_TOKEN=${TOKEN}`],
    credential: { ...PACK.credential, secretOnce: TOKEN, transport: 'any' },
  };

  it.each([
    ['Claude Code', 'full', 'claude-code'],
    ['Codex', 'full', 'openai-codex'],
    ['VS Code', 'presence', 'vscode'],
    ['Antigravity', 'presence', 'antigravity'],
  ])('%s: one any-pinned token with exactly the harness set, and the descriptor in the same call', async (label, tier, product) => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);

    await connect(label, 'Workstation');
    await waitFor(() => expect(posted).toHaveLength(1));

    const body = posted[0];
    expect(body.kind).toBe('connector');
    expect(body.issueCredential.transport).toBe('any');
    const requested: string[] = body.issueCredential.scopes;
    expect([...requested].sort()).toEqual([...HARNESS_EXPECTED].sort());
    // The shape the design forbids, each stated as its own failing assertion.
    expect(requested).not.toContain('root');
    expect(requested).not.toContain('services:write');
    expect(requested.filter((scope) => scope.endsWith(':admin'))).toEqual([]);
    // Not vacuous: the administrator MAY delegate every one of those.
    expect(FULL_DELEGABLE).toEqual(expect.arrayContaining(['services:write', 'tasks:admin', 'services:admin']));
    // The extra jobs of the one token are on it.
    expect(requested).toEqual(expect.arrayContaining(['telemetry:write', 'services:read', 'principals:read']));
    // E475 (1): the wizard mints the three additions, and none of their wider
    // neighbours, though this administrator may delegate every one of them.
    expect(requested).toEqual(expect.arrayContaining(['knowledge-contents:read', 'personalities:read', 'blueprints:use']));
    for (const wider of ['blueprints:read', 'blueprints:write', 'personalities:write', 'knowledge-contents:write',
      'projects:admin', 'phases:admin']) {
      expect(FULL_DELEGABLE).toContain(wider);
      expect(requested).not.toContain(wider);
    }
    // E480: and the two write verbs instantiating a Blueprint needs.
    expect(requested).toEqual(expect.arrayContaining(['projects:write', 'phases:write']));
    expect(requested).toHaveLength(16);
    // And the connector is registered WITH its declaration, in this request.
    expect(body.descriptor).toEqual({ options: [], telemetry: { tier, products: [product] } });
    expect(await screen.findByText('Set up Workstation')).toBeInTheDocument();
  });

  it('the menu IS the harness set: nothing above it is offered, and the sentence says what it is', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));

    expect(screen.getByText(
      `This connection gets one token for the board's tools, reporting and wake: ${HARNESS_EXPECTED.length} of the ${HARNESS_EXPECTED.length} things a harness connection can be given. It is never given administrator rights or the right to change services.`,
    )).toBeInTheDocument();
    // The decision-1 sentence would be false here and is not shown.
    expect(screen.queryByText(/never given to a connection, so this one starts/)).not.toBeInTheDocument();
    // Nothing of the harness set is out of reach, so there is no warning (E462 S2).
    expect(HARNESS_EXPECTED).toHaveLength(HARNESS_CONNECTOR_SCOPES.length);
    expect(screen.queryByTestId('harness-delegation-warning')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    expect([...offeredScopes()].sort()).toEqual([...HARNESS_EXPECTED].sort());
    expect(checkedScopes().sort()).toEqual([...HARNESS_EXPECTED].sort());
    // The menu is its own recommended set, so the redundant button is absent.
    expect(screen.queryByRole('button', { name: /Use the recommended set/ })).not.toBeInTheDocument();
  });

  it('narrowing still works inside the harness set, and the request carries only what is ticked', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await userEvent.click(boxFor('skills:use'));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Workstation');
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(posted).toHaveLength(1));

    const requested: string[] = posted[0].issueCredential.scopes;
    expect(requested).not.toContain('skills:use');
    expect([...requested].sort()).toEqual(HARNESS_EXPECTED.filter((scope) => scope !== 'skills:use').sort());
  });

  it('a Member gets the harness set cut down to what THEY may delegate, never more', async () => {
    const member = ['tasks:read', 'tasks:write', 'reports:read', 'telemetry:write', 'principals:read'];
    session({ role: 'user', scopes: member, delegableScopes: member });
    render(<ConnectAgentWizard />);
    await screen.findByText(/everything you can do/);
    await connect('Antigravity', 'Mac');
    await waitFor(() => expect(posted).toHaveLength(1));
    expect([...posted[0].issueCredential.scopes].sort()).toEqual([...member].sort());
    expect(posted[0].descriptor.telemetry.products).toEqual(['antigravity']);
  });

  it('a Member is told BY NAME which harness scopes the token will lack, and the count is against the whole set (E462 S2)', async () => {
    const member = ['tasks:read', 'tasks:write', 'reports:read', 'telemetry:write', 'principals:read'];
    session({ role: 'user', scopes: member, delegableScopes: member });
    render(<ConnectAgentWizard />);
    await screen.findByText(/everything you can do/);
    await userEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    const warning = await screen.findByTestId('harness-delegation-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning.textContent).toBe(
      'You cannot pass on reports:write, projects:read, phases:read, skills:read, skills:use, services:read, '
      + 'knowledge-contents:read, personalities:read, blueprints:use, projects:write and phases:write, '
      + 'so this token will not have them. The connector needs the whole harness set: relayhall connector check '
      + 'will fail until someone who can delegate them widens the token on the Credentials page.',
    );
    expect(screen.getByText(
      `This connection gets one token for the board's tools, reporting and wake: 5 of the ${HARNESS_CONNECTOR_SCOPES.length} things a harness connection can be given. It is never given administrator rights or the right to change services.`,
    )).toBeInTheDocument();
    // CONTROL: an ordinary template has no harness set to fall short of.
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    expect(screen.queryByTestId('harness-delegation-warning')).not.toBeInTheDocument();
  });

  it('changing between a harness and an ordinary template re-defaults the selection to that menu', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await userEvent.click(screen.getByRole('radio', { name: /Generic MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(offeredScopes()).toHaveLength(FULL_DELEGABLE.length));
    await userEvent.click(boxFor('tasks:admin'));
    expect(checkedScopes()).not.toContain('tasks:admin');

    // A selection made against the wide menu is not carried onto the harness menu.
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await waitFor(() => expect([...offeredScopes()].sort()).toEqual([...HARNESS_EXPECTED].sort()));
    expect(checkedScopes().sort()).toEqual([...HARNESS_EXPECTED].sort());

    // And back: the ordinary template's decision-1 default returns whole.
    await userEvent.click(screen.getByRole('radio', { name: /API script/ }));
    await waitFor(() => expect(offeredScopes()).toHaveLength(FULL_DELEGABLE.length));
    expect(checkedScopes().sort()).toEqual([...FULL_DELEGABLE].sort());
  });

  it('CONTROL: an ordinary template sends no descriptor and keeps its own pin', async () => {
    session({ role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await connect('API script', 'CI runner');
    await waitFor(() => expect(posted).toHaveLength(1));
    expect('descriptor' in posted[0]).toBe(false);
    expect(posted[0].issueCredential.transport).toBe('api');
  });

  it('step 3 leads with the install line and the token for its hidden prompt; the line carries no credential', async () => {
    session({
      role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE,
      serviceAnswer: () => ok({ success: true, service: { id: 's1' }, onboarding: TOKEN_PACK }),
    });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await connect('Codex', 'Workstation');

    const line = await screen.findByTestId('install-line');
    expect(line.textContent).toBe('relayhall connector install --harness codex --board https://board.example');
    expect(line.textContent).not.toContain(TOKEN);
    expect(screen.getByTestId('installer-token').textContent).toBe(TOKEN);
    expect(screen.getByRole('button', { name: 'Copy the install line' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the token for the installer' })).toBeInTheDocument();
    // The manual setup is still there, folded under one closed disclosure (E462 S2).
    const manual = screen.getByTestId('manual-setup');
    expect(manual.tagName).toBe('DETAILS');
    expect(manual).not.toHaveAttribute('open');
    expect(manual).toContainElement(screen.getByText('Paste this into your agent and let it configure itself.'));
    expect(screen.queryByTestId('install-note')).not.toBeInTheDocument();
  });

  it('Antigravity says where the installer writes its MCP config (E475 (2))', async () => {
    session({
      role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE,
      serviceAnswer: () => ok({ success: true, service: { id: 's1' }, onboarding: TOKEN_PACK }),
    });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await connect('Antigravity', 'Mac');
    const note = (await screen.findByTestId('install-note')).textContent;
    expect(note).toContain('~/.gemini/config/mcp_config.json');
    expect(note).not.toMatch(/does not edit Antigravity's configuration/);
  });

  it('CONTROL: an ordinary template shows no install section at all', async () => {
    session({
      role: 'admin', scopes: ['root'], delegableScopes: FULL_DELEGABLE,
      serviceAnswer: () => ok({ success: true, service: { id: 's1' }, onboarding: TOKEN_PACK }),
    });
    render(<ConnectAgentWizard />);
    await screen.findByText(/never given to a connection/);
    await connect('Generic MCP client', 'Plain');
    await screen.findByText('Set up Plain');
    expect(screen.queryByTestId('install-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('installer-token')).not.toBeInTheDocument();
  });
});
