/*
 * The bootstrap prompt in the bootstrap pane (card 94e8bb0b item 1).
 *
 * What is pinned:
 *  - the pane offers exactly ONE copyable bootstrap prompt, and its text and
 *    its clipboard payload are the pack's own text, byte for byte;
 *  - the prompt carries no credential although the same pack does (a control
 *    proves the counter can see the credential where it really is);
 *  - the secure configuration guidance renders line for line;
 *  - an `api`-pinned connection says the MCP prompt does not apply instead of
 *    offering one its credential would be refused for;
 *  - at desktop and phone widths the prompt and the guidance are the same text
 *    in a block whose stylesheet wraps it. jsdom performs no layout, so the
 *    width claim is carried by the rule the block's class is bound to — read
 *    from the stylesheet on disk, because a `?raw` import of CSS is empty
 *    under vitest — and not by a measured box.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapPane, BootstrapPaneProps } from './BootstrapPane';
import { CREDENTIAL_TOKEN_PATTERN, ConnectionTransport } from '../../types/connections';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_TOKEN = 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000';
const MCP = 'https://board.example/api/mcp';

/** The prompt as `composeBootstrapPrompt` renders it for this endpoint. */
const PROMPT = [
  `Connect to the RelayHall MCP server "relayhall" at ${MCP} with the credential from your secure store; never paste the credential into this chat.`,
  "Read only the board, through this MCP server, and this connector's own folders (its MCP entry, its local connection skill and its state folder); never the owner's private working set, other sessions' scratchpads or other hosts.",
  'Call relayhall_brief_compile with {"session": true} to get your session brief.',
  'Find the published Skill relayhall-connector-bootstrap with relayhall_skill_list, load it with relayhall_skill_get (fullContent: true) and run the onboarding it describes, using only what this harness supports.',
  'Finish with a readiness matrix: measured results with real ids, then the remaining gaps. Do not arm or claim unrelated work.',
].join('\n');

const GUIDANCE = [
  `Register the MCP server as "relayhall" at ${MCP} using the block for your client.`,
  "Keep the credential in your client's secret store or the RELAYHALL_TOKEN environment variable.",
  'Then paste the bootstrap prompt into a fresh session.',
];

const props = (overrides: Partial<BootstrapPaneProps> = {}): BootstrapPaneProps => ({
  mcpConfig: {
    claudeCode: { mcpServers: { relayhall: { type: 'http', url: MCP, headers: { Authorization: `Bearer ${REAL_TOKEN}` } } } },
    codex: `[mcp_servers.relayhall]\nurl = "${MCP}"\nbearer_token_env_var = "RELAYHALL_TOKEN"`,
    generic: { transport: 'streamable-http', url: MCP, headers: { Authorization: `Bearer ${REAL_TOKEN}` } },
  },
  cliEnv: ['export RELAYHALL_API_URL=https://board.example/api', `export RELAYHALL_TOKEN=${REAL_TOKEN}`],
  bootstrapLine: 'You have a RelayHall board at https://board.example/api. Authenticate with your credential and fetch everything else from it.',
  boardEndpoint: 'https://board.example/api',
  transport: 'mcp',
  carriesSecret: true,
  recovery: 'create a new credential',
  bootstrapPrompt: PROMPT,
  configurationGuidance: GUIDANCE,
  ...overrides,
});

const promptBlock = () => screen.queryByTestId('bootstrap-prompt');
const sightings = (text: string) => text.split(REAL_TOKEN).length - 1;
const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(cleanup);

describe('the bootstrap prompt', () => {
  it('is offered once, as the pack composed it, with its own copy button', async () => {
    render(<BootstrapPane {...props()} />);
    expect(screen.getAllByTestId('bootstrap-prompt')).toHaveLength(1);
    expect(promptBlock()!.textContent).toBe(PROMPT);
    await userEvent.click(screen.getByRole('button', { name: 'Copy the bootstrap prompt' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByRole('button', { name: 'Copy the bootstrap prompt' })).toHaveTextContent('Copied');
  });

  it('carries no credential although the pack it sits in does', () => {
    render(<BootstrapPane {...props()} />);
    const prompt = promptBlock()!.textContent ?? '';
    expect(sightings(prompt)).toBe(0);
    expect(CREDENTIAL_TOKEN_PATTERN.test(prompt)).toBe(false);
    // CONTROL: the configuration block on the same screen carries it once, so
    // the zero above is a measurement and not a counter that cannot count.
    const config = document.querySelector('.conn-copyblock-body')!.textContent ?? '';
    expect(sightings(config)).toBe(1);
  });

  it('renders the secure configuration guidance line for line', () => {
    render(<BootstrapPane {...props()} />);
    const items = Array.from(document.querySelectorAll('.conn-bootstrap-guidance li')).map((li) => li.textContent);
    expect(items).toEqual(GUIDANCE);
    expect(screen.getByText('Secure configuration')).toBeInTheDocument();
  });

  it.each<ConnectionTransport>(['any', 'mcp'])('is offered on a %s connection', (transport) => {
    render(<BootstrapPane {...props({ transport })} />);
    expect(promptBlock()).toBeInTheDocument();
  });

  it('an api-pinned connection says the MCP prompt does not apply, and offers neither prompt nor MCP guidance', () => {
    render(<BootstrapPane {...props({ transport: 'api', initialTab: 'cli' })} />);
    expect(promptBlock()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy the bootstrap prompt' })).not.toBeInTheDocument();
    expect(document.querySelector('.conn-bootstrap-guidance')).toBeNull();
    expect(screen.getByText(/pinned to the api transport, so the MCP bootstrap prompt does not/)).toBeInTheDocument();
  });

  it('a pack without a prompt renders the pane as before, with no empty prompt block', () => {
    render(<BootstrapPane {...props({ bootstrapPrompt: undefined, configurationGuidance: undefined })} />);
    expect(promptBlock()).not.toBeInTheDocument();
    expect(document.querySelector('.conn-bootstrap-guidance')).toBeNull();
    expect(screen.getByText('Paste this into your agent and let it configure itself.')).toBeInTheDocument();
  });

  it('re-shown without the secret, the prompt is the same text', () => {
    render(<BootstrapPane {...props({ carriesSecret: false })} />);
    expect(promptBlock()!.textContent).toBe(PROMPT);
  });
});

describe('desktop and phone widths', () => {
  const css = readFileSync(join(HERE, 'connections.css'), 'utf-8');
  const rule = (selector: string) => {
    const match = css.match(new RegExp(`(^|\\n)${selector.replace(/[.-]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`));
    return match ? match[2] : null;
  };

  it('CONTROL: the stylesheet was read, and the rule reader finds a rule it knows exists', () => {
    expect(css.length).toBeGreaterThan(0);
    expect(rule('.conn-copyblock-body')).toContain('overflow: auto');
    expect(rule('.conn-not-a-class')).toBeNull();
  });

  it.each([
    ['desktop', 1280],
    ['phone', 375],
  ])('at %s width (%ipx) the prompt and guidance are complete and sit in wrapping blocks', (_label, width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    render(<BootstrapPane {...props()} />);
    const block = promptBlock()!;
    expect(block.textContent).toBe(PROMPT);
    expect(block).toHaveClass('conn-copyblock-body', 'conn-copyblock-body--wrap');
    const items = Array.from(document.querySelectorAll('.conn-bootstrap-guidance li')).map((li) => li.textContent);
    expect(items).toEqual(GUIDANCE);
  });

  it('the wrap modifier wraps prose and long URLs, and is declared after the base rule it overrides', () => {
    const wrap = rule('.conn-copyblock-body--wrap');
    expect(wrap).toContain('white-space: pre-wrap');
    expect(wrap).toContain('overflow-wrap: anywhere');
    // Equal specificity, so source order decides which white-space wins.
    expect(css.indexOf('.conn-copyblock-body--wrap {')).toBeGreaterThan(css.indexOf('.conn-copyblock-body {'));
    expect(rule('.conn-bootstrap-guidance')).toContain('overflow-wrap: anywhere');
  });
});

describe('the install line of a harness connection (E462 slice S1)', () => {
  const LINE = 'relayhall connector install --harness claude-code --board https://board.example';
  const installLine = () => screen.queryByTestId('install-line');
  const installerToken = () => screen.queryByTestId('installer-token');

  it('leads with the install line, and its copy button puts exactly that line on the clipboard', async () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    expect(installLine()!.textContent).toBe(LINE);
    // It comes BEFORE the manual blocks in the page.
    const manual = screen.getByTestId('tab-block');
    expect(installLine()!.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copy the install line' }));
    expect(writeText).toHaveBeenCalledWith(LINE);
  });

  it('gives the installer its token in a block of its own, once, and the line itself carries none', async () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    expect(installerToken()!.textContent).toBe(REAL_TOKEN);
    expect(sightings(installLine()!.textContent ?? '')).toBe(0);
    expect(CREDENTIAL_TOKEN_PATTERN.test(LINE)).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Copy the token for the installer' }));
    expect(writeText).toHaveBeenCalledWith(REAL_TOKEN);
  });

  it('CONTROL: the counter reads the token where it really is, so the zero above is a measurement', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    expect(sightings(installerToken()!.textContent ?? '')).toBe(1);
  });

  it('re-shown without the secret, the line stays and the token block does not', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE, carriesSecret: false })} />);
    expect(installLine()!.textContent).toBe(LINE);
    expect(installerToken()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy the token for the installer' })).not.toBeInTheDocument();
    expect(screen.getByText(/The token was shown once, when the connection was made/)).toBeInTheDocument();
  });

  it('no install line, no install section: the pane is exactly what it was', () => {
    render(<BootstrapPane {...props()} />);
    expect(installLine()).not.toBeInTheDocument();
    expect(installerToken()).not.toBeInTheDocument();
    expect(screen.queryByText('Install the connector')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy the install line' })).not.toBeInTheDocument();
  });

  it('says plainly that the manual blocks put the token in the client configuration', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    expect(screen.getByText(/asks for the token at a\s+hidden prompt/)).toBeInTheDocument();
    expect(screen.getByText(/put the token in the client.s\s+own configuration or environment/)).toBeInTheDocument();
  });

  it('wraps at every width: the install block has its own wrapping rule in the stylesheet', () => {
    const css = readFileSync(join(HERE, 'connections.css'), 'utf-8');
    const match = css.match(/(^|\n)\.conn-install-body \{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match![2]).toContain('white-space: pre-wrap');
    expect(match![2]).toContain('overflow-wrap: anywhere');
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    expect(installLine()).toHaveClass('conn-install-body');
  });
});

describe('the manual blocks fold away under the install line (E462 slice S2)', () => {
  const LINE = 'relayhall connector install --harness codex --board https://board.example';

  it('puts every per-client snippet, the token env lines and the guidance in ONE closed disclosure', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE, initialTab: 'codex' })} />);
    const manual = screen.getByTestId('manual-setup');
    expect(manual.tagName).toBe('DETAILS');
    expect(manual).not.toHaveAttribute('open');
    expect(manual.querySelector('summary')!.textContent).toBe('Set up by hand instead');
    for (const inside of [
      screen.getByTestId('tab-block'),
      screen.getByText('Paste this into your agent and let it configure itself.'),
      screen.getByRole('button', { name: 'Copy the RELAYHALL_TOKEN lines', hidden: true }),
      screen.getByText('Secure configuration'),
    ]) {
      expect(manual).toContainElement(inside);
    }
    // The install section and the bootstrap prompt stay outside it.
    expect(manual).not.toContainElement(screen.getByTestId('install-line'));
    expect(manual).not.toContainElement(screen.getByTestId('bootstrap-prompt'));
  });

  it('the disclosure says what the manual route costs before anything in it', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    const manual = screen.getByTestId('manual-setup');
    const warning = within(manual).getByRole('note');
    expect(warning.textContent).toMatch(/installer never does/);
    expect(warning.compareDocumentPosition(screen.getByTestId('tab-block')) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('opens on its summary, and the snippets inside still copy exactly their block', async () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    await userEvent.click(screen.getByText('Set up by hand instead'));
    expect(screen.getByTestId('manual-setup')).toHaveAttribute('open');
    await userEvent.click(screen.getByRole('button', { name: 'Copy the Claude Code setup block' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"relayhall"'));
  });

  it('says what the installer does in this version, and where it does not run', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE })} />);
    const what = screen.getByTestId('install-what').textContent ?? '';
    expect(what).toMatch(/On Windows/);
    expect(what).toMatch(/DPAPI/);
    expect(what).toMatch(/configuration never holds the token/);
    expect(what).toMatch(/without administrator rights/);
    expect(what).toContain('relayhall connector check');
    expect(what).toContain('relayhall connector uninstall');
    expect(screen.getByText(/does not run on macOS or Linux yet/)).toBeInTheDocument();
    expect(screen.getByText(/Python 3\.10 or newer/)).toBeInTheDocument();
  });

  it('renders the per-harness note when there is one', () => {
    render(<BootstrapPane {...props({ transport: 'any', installLine: LINE, installNote: 'A note for this harness.' })} />);
    expect(screen.getByTestId('install-note').textContent).toBe('A note for this harness.');
  });

  it('CONTROL: without an install line nothing is folded and nothing new is said', () => {
    render(<BootstrapPane {...props()} />);
    expect(screen.queryByTestId('manual-setup')).not.toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
    expect(screen.getByTestId('tab-block')).toBeVisible();
    expect(screen.queryByTestId('install-what')).not.toBeInTheDocument();
    expect(screen.getByText('Secure configuration')).toBeInTheDocument();
  });
});
