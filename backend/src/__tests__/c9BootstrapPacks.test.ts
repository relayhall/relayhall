/**
 * RH-P3.C9 — the in-repo bootstrap packs may not drift from the product.
 *
 * Strategy §2.10 ships per-harness bootstrap packs in this repository
 * (CLAUDE.md + a SessionStart hook, AGENTS.md, GEMINI.md). A pack is a
 * document, and a document that describes behaviour the code does not have is
 * exactly the failure this suite exists to make unrepresentable — reviewing
 * the prose by eye is what fails.
 *
 * Nothing below is a reading of the prose. Three mechanisms:
 *
 *  1. THE CONFIGURATION AND THE BOOTSTRAP LINE COME FROM THE PRODUCTION
 *     RENDERER. A committed pack cannot carry a real endpoint or a real
 *     secret, so it publishes the same placeholders docs/mcp.md publishes.
 *     Feeding those placeholders to `composeOnboardingPack()` — the function
 *     that renders the one-time onboarding pack when a credential is minted —
 *     makes the rendered value and the committed bytes directly comparable:
 *     no normalisation, no substring guessing, no second copy of the contract
 *     living in this file.
 *
 *  2. THE SURFACE CLAIMS LISTED BELOW ARE CHECKED AGAINST THE SURFACE — the
 *     ones enumerated here, not "every claim": review 4ab06516 B1 rejected an
 *     earlier draft of this comment for claiming the wider thing while
 *     asserting the narrower one. The tool the packs tell a harness to call is
 *     resolved through `toolByName`; every `relayhall_*` identifier they name
 *     must be a registered tool; the twelve hours is derived from
 *     `BOOTSTRAP_TTL_MS`; the tools they say stay open must sit in a plane
 *     `BOOTSTRAP_EXEMPT_PLANES` exempts; and the sentence stating WHAT IS
 *     REFUSED BEFORE BOOTSTRAP is rendered by production
 *     (`bootstrapPolicySentence()`) and compared byte for byte, because that
 *     prose was previously unbound and could be inverted while this suite
 *     stayed green.
 *
 *  3. THE HOOK IS EXECUTED, NOT READ — and it is executed through the command
 *     `.claude/settings.json` configures, not by calling the script directly.
 *     A hook whose script is perfect and whose wiring is wrong injects
 *     nothing, and reading the script would not notice.
 *
 * Every comparison has a negative control beside it: the same assertion run
 * against a mutated copy of the same document must fail. A green run without
 * those is only evidence that the assertions ran.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BOOTSTRAP_EXEMPT_PLANES, BOOTSTRAP_REFUSAL_MARKER, bootstrapGate, bootstrapPolicySentence,
} from '../mcp/bootstrapGate';
import { mcpChallengeFor } from '../mcp/provenance';
import {
  OAUTH_GRANT_TYPES_SUPPORTED, OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED,
  tierBAvailabilitySentence,
} from '../utils/oauthMetadata';
import {
  oauthAuthorizationService, verifyPkceS256, OAuthError,
} from '../services/OAuthAuthorizationService';
import { oauthClientMetadataService } from '../services/OAuthClientMetadataService';

/**
 * Grant names a client could present at the token endpoint.
 *
 * The ADVERTISED set is subtracted from this list, so the two loops in the
 * behavioural anchor below are DERIVED from `OAUTH_GRANT_TYPES_SUPPORTED`
 * rather than written down beside it. That is the whole repair for verdict
 * 6fe97bc5 B1: there is no value here that can be edited to absorb a change to
 * the constant, because whatever the constant says lands in one loop and
 * everything else lands in the other.
 */
const GRANTS_A_CLIENT_COULD_PRESENT = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
  'password',
  'implicit',
  'urn:ietf:params:oauth:grant-type:token-exchange',
  'urn:ietf:params:oauth:grant-type:device_code',
];

/** PKCE method names a client could present at the authorization endpoint. */
const PKCE_METHODS_A_CLIENT_COULD_PRESENT = ['S256', 'plain', 'S512'];

/**
 * RFC 7636 Appendix B, verbatim — the specification's own known-answer pair.
 *
 * Review dc8691db B1: the previous anchor picked a transform out of a
 * test-owned map, so swapping the map bodies relabelled SHA-256 as `plain` and
 * the suite stayed green. THERE IS NO TRANSFORM IN THIS FILE ANY MORE. These
 * are fixed protocol constants; production is measured against them, and what
 * it is measured to implement is what it must advertise.
 */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_S256_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
import type { McpCallContext } from '../mcp/rest';
import { MCP_TOOLS, toolByName } from '../mcp/registry';
import { BOOTSTRAP_TTL_MS } from '../services/McpBootstrapService';
import { composeOnboardingPack } from '../utils/onboardingPack';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// The placeholders the packs and docs/mcp.md publish. They are inputs to the
// production renderer here, which is what makes a committed snippet and a
// rendered snippet the same kind of thing.
const PLACEHOLDER_ENDPOINT = 'https://<your-board>/api';
const PLACEHOLDER_SECRET = '${RELAYHALL_TOKEN}';

const rendered = composeOnboardingPack({
  endpoint: PLACEHOLDER_ENDPOINT,
  credential: {
    credentialId: '00000000-0000-0000-0000-000000000000',
    keyId: 'placeholder',
    secretOnce: PLACEHOLDER_SECRET,
    expiresAt: null,
    transport: 'mcp',
  },
  scopes: [],
  rules: [],
});

/** The bootstrap call, as every surface publishes it. */
const BOOTSTRAP_CALL = {
  name: 'relayhall_brief_compile',
  arguments: { session: true },
};

const TTL_HOURS = BOOTSTRAP_TTL_MS / (60 * 60 * 1000);

/**
 * The tools each pack names as reachable before a credential has bootstrapped.
 * Listed here and checked against the registry below, so the claim is bound to
 * the planes the gate actually exempts rather than to this list.
 */
const NAMED_OPEN_BEFORE_BOOTSTRAP = [
  'relayhall_principal_whoami',
  'relayhall_access_preview',
  'relayhall_task_list',
  'relayhall_report_search',
];

const PACKS = [
  { file: 'CLAUDE.md', config: rendered.mcpConfig.claudeCode },
  { file: 'GEMINI.md', config: rendered.mcpConfig.generic },
];
const ALL_PACK_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

interface Fence { lang: string; body: string }

/** Fenced blocks, in document order, with their info string. */
function fences(text: string): Fence[] {
  const blocks: Fence[] = [];
  let open: Fence | null = null;
  for (const line of text.split('\n')) {
    const marker = /^```(\S*)\s*$/.exec(line);
    if (marker) {
      if (open) {
        blocks.push({ lang: open.lang, body: open.body.replace(/\n$/, '') });
        open = null;
      } else {
        open = { lang: marker[1], body: '' };
      }
      continue;
    }
    if (open) open.body += `${line}\n`;
  }
  if (open) throw new Error('unterminated fenced block');
  return blocks;
}

const jsonBlocks = (text: string): unknown[] =>
  fences(text).filter((f) => f.lang === 'json').map((f) => JSON.parse(f.body));
const tomlBlocks = (text: string): string[] =>
  fences(text).filter((f) => f.lang === 'toml').map((f) => f.body.trim());

describe('the committed packs carry exactly what the board renders', () => {
  it.each(PACKS)('$file publishes the rendered config and the bootstrap call, and nothing else', ({ file, config }) => {
    // An exact ordered comparison, not "contains one that matches": a second
    // JSON block carrying a different endpoint would be drift that a
    // containment check would pass.
    expect(jsonBlocks(read(file))).toEqual([config, BOOTSTRAP_CALL]);
  });

  it('AGENTS.md publishes the rendered Codex snippet and the bootstrap call', () => {
    expect(tomlBlocks(read('AGENTS.md'))).toEqual([rendered.mcpConfig.codex]);
    expect(jsonBlocks(read('AGENTS.md'))).toEqual([BOOTSTRAP_CALL]);
  });

  it.each(ALL_PACK_FILES)('%s carries the rendered bootstrap line verbatim', (file) => {
    expect(read(file)).toContain(rendered.bootstrapLine);
  });

  it('a config that drifted by one character fails that comparison', () => {
    const original = read('CLAUDE.md');
    const drifted = original.replace('/api/mcp"', '/api/mcp/v2"');
    expect(drifted).not.toEqual(original); // the mutation landed
    expect(jsonBlocks(drifted)).not.toEqual([rendered.mcpConfig.claudeCode, BOOTSTRAP_CALL]);
  });

  it('a bootstrap line that drifted in meaning fails that comparison', () => {
    const drifted = read('AGENTS.md').replace(
      'fetch everything else from it',
      'use whatever you already have locally',
    );
    expect(drifted).not.toEqual(read('AGENTS.md')); // the mutation landed
    expect(drifted).not.toContain(rendered.bootstrapLine);
  });

  it('an extra config block fails the exact comparison', () => {
    const drifted = read('GEMINI.md').replace(
      '## Bootstrap first',
      '```json\n{"transport": "stdio"}\n```\n\n## Bootstrap first',
    );
    expect(jsonBlocks(drifted)).not.toEqual([rendered.mcpConfig.generic, BOOTSTRAP_CALL]);
  });
});

describe('docs/mcp.md publishes the same configuration as the packs', () => {
  const doc = read('docs/mcp.md');

  it('carries the rendered Claude Code config', () => {
    expect(jsonBlocks(doc)).toContainEqual(rendered.mcpConfig.claudeCode);
  });

  it('carries the rendered Codex snippet', () => {
    expect(tomlBlocks(doc)).toContainEqual(rendered.mcpConfig.codex);
  });

  it('carries the same bootstrap call the packs publish', () => {
    expect(jsonBlocks(doc)).toContainEqual(BOOTSTRAP_CALL);
  });
});

describe('every claim the packs make about the surface is checked against the surface', () => {
  it('the tool the packs tell a harness to call is a registered bootstrap-plane tool', () => {
    const tool = toolByName(BOOTSTRAP_CALL.name);
    expect(tool).toBeDefined();
    expect(tool!.plane).toBe('bootstrap');
    const properties = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    expect(properties.session).toBeDefined();
    expect(properties.session.type).toBe('boolean');
  });

  it.each([...ALL_PACK_FILES, 'docs/harness-support.md'])(
    '%s names no tool that does not exist',
    (file) => {
      const registered = new Set(MCP_TOOLS.map((tool) => tool.name));
      const named = read(file).match(/\brelayhall_[a-z_]+\b/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      expect([...new Set(named)].filter((name) => !registered.has(name))).toEqual([]);
    },
  );

  it('a pack naming a retired tool fails that check', () => {
    const registered = new Set(MCP_TOOLS.map((tool) => tool.name));
    // `relayhall_task_phase_set` was folded into `relayhall_task_update` at
    // the v2 re-scope; a pack still naming it is precisely the drift this
    // check is for.
    const drifted = read('CLAUDE.md').replace('relayhall_task_get', 'relayhall_task_phase_set');
    const named = drifted.match(/\brelayhall_[a-z_]+\b/g) ?? [];
    expect([...new Set(named)].filter((name) => !registered.has(name))).toEqual(['relayhall_task_phase_set']);
  });

  it('the tools the packs say stay open really sit in an exempt plane', () => {
    expect(BOOTSTRAP_EXEMPT_PLANES.length).toBeGreaterThan(0);
    for (const name of NAMED_OPEN_BEFORE_BOOTSTRAP) {
      const tool = toolByName(name);
      expect(tool).toBeDefined();
      expect(BOOTSTRAP_EXEMPT_PLANES).toContain(tool!.plane);
    }
  });

  it('every tool the packs list as open is actually listed by every pack', () => {
    for (const file of ALL_PACK_FILES) {
      const text = read(file);
      for (const name of NAMED_OPEN_BEFORE_BOOTSTRAP) expect(text).toContain(name);
    }
  });

  it('a work-plane tool would fail the exempt-plane check', () => {
    // The control the check needs: a tool that is NOT exempt, proving the
    // assertion above can distinguish the two planes rather than passing on
    // everything the registry contains.
    const mutating = toolByName('relayhall_task_create');
    expect(mutating).toBeDefined();
    expect(mutating!.plane).toBe('work');
    expect(BOOTSTRAP_EXEMPT_PLANES).not.toContain(mutating!.plane);
  });

  it.each(ALL_PACK_FILES)('%s quotes the bootstrap policy the gate actually enforces', (file) => {
    // Byte-for-byte against what production renders from
    // BOOTSTRAP_EXEMPT_PLANES. Adding a plane to the exempt set changes this
    // string and turns every document that still quotes the old one red.
    expect(read(file)).toContain(bootstrapPolicySentence());
  });

  it('the rendered sentence matches an oracle built here, not from the renderer', () => {
    // Review 41b196d3 B1: every earlier assertion compared one string to
    // another string that moved with it, so inverting the renderer AND its
    // consumers together stayed green. This oracle is built from the gate's
    // own constants with the RELATION written here — exempt planes answer,
    // the complement is refused — so inverting the renderer alone turns it
    // red no matter what the documents were changed to say.
    const open = [...BOOTSTRAP_EXEMPT_PLANES].join(' and ');
    const expected = `Before this credential has bootstrapped, only the ${open} planes answer; `
      + `every other tool is refused with "${BOOTSTRAP_REFUSAL_MARKER}".`;
    expect(bootstrapPolicySentence()).toEqual(expected);
  });

  it('the planes the sentence says answer are the planes the gate really lets through', async () => {
    // Behaviour, not text: the exempt check is the gate's first act and needs
    // no credential and no database, so every exempt plane can be observed
    // directly. A renderer that renamed the open set would still pass the
    // oracle above if the constant moved with it; it cannot pass this.
    const ctx = { authorization: '', toolName: 'probe' } as unknown as McpCallContext;
    for (const plane of BOOTSTRAP_EXEMPT_PLANES) {
      const tool = MCP_TOOLS.find((candidate) => candidate.plane === plane);
      expect(tool).toBeDefined();
      await expect(bootstrapGate(tool!, ctx)).resolves.toBeNull();
      expect(bootstrapPolicySentence()).toContain(plane);
    }
  });

  it('a plane the gate does NOT exempt is not described as one that answers', async () => {
    // The control the check above needs: a plane whose tools the gate refuses,
    // proving the observation distinguishes the two rather than passing on
    // everything in the registry.
    const refusedPlanes = [...new Set(MCP_TOOLS.map((tool) => tool.plane))]
      .filter((plane) => !BOOTSTRAP_EXEMPT_PLANES.includes(plane));
    expect(refusedPlanes.length).toBeGreaterThan(0);
    for (const plane of refusedPlanes) {
      expect(bootstrapPolicySentence()).not.toContain(`${plane} planes answer`);
      expect(bootstrapPolicySentence()).not.toContain(`the ${plane} plane`);
    }
  });

  it('the rendered policy names exactly the planes the gate exempts, and something is refused', () => {
    const sentence = bootstrapPolicySentence();
    for (const plane of BOOTSTRAP_EXEMPT_PLANES) expect(sentence).toContain(plane);
    // "every other tool is refused" is only a claim if a non-exempt plane
    // exists in the live registry.
    const refused = [...new Set(MCP_TOOLS.map((tool) => tool.plane))]
      .filter((plane) => !BOOTSTRAP_EXEMPT_PLANES.includes(plane));
    expect(refused.length).toBeGreaterThan(0);
    // ...and no plane the gate refuses may be named as one that answers.
    for (const plane of refused) expect(sentence).not.toContain(`the ${plane} plane`);
  });

  it.each(ALL_PACK_FILES)('%s cannot be inverted and stay green (review 4ab06516 B1)', (file) => {
    // The exact hostile replacement the review used against the packs.
    const inverted = read(file).replace(
      bootstrapPolicySentence(),
      'Everything that changes board state is allowed without bootstrapping.',
    );
    expect(inverted).not.toEqual(read(file)); // the mutation landed
    expect(inverted).not.toContain(bootstrapPolicySentence());
  });

  it.each(ALL_PACK_FILES)('%s quotes the lifetime the server actually records', (file) => {
    // Derived from BOOTSTRAP_TTL_MS, so changing the constant turns this red
    // rather than leaving three documents quietly wrong.
    expect(read(file)).toContain(`bootstrapped for **${TTL_HOURS} hours**`);
  });

  it('a changed lifetime would fail that check', () => {
    const drifted = read('CLAUDE.md').replace(`for **${TTL_HOURS} hours**`, `for **${TTL_HOURS + 1} hours**`);
    expect(drifted).not.toContain(`bootstrapped for **${TTL_HOURS} hours**`);
  });
});

describe('the Claude Code session hook is wired, runs, and injects the same values', () => {
  const settings = JSON.parse(read('.claude/settings.json')) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string }> }> };
  };
  const configured = settings.hooks.SessionStart.flatMap((group) => group.hooks);

  const runConfigured = (env: NodeJS.ProcessEnv): string =>
    execFileSync('bash', ['-c', configured[0].command], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
    });

  it('configures exactly one SessionStart command, and it is the shipped script', () => {
    expect(configured).toHaveLength(1);
    expect(configured[0].type).toBe('command');
    expect(configured[0].command).toContain('.claude/hooks/relayhall-session-start.sh');
    expect(fs.existsSync(path.join(REPO_ROOT, '.claude/hooks/relayhall-session-start.sh'))).toBe(true);
  });

  it('emits the documented SessionStart contract when run as configured', () => {
    const parsed = JSON.parse(runConfigured({ ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT }));
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  });

  it('injects the rendered bootstrap line, the bootstrap call and the recorded lifetime', () => {
    const parsed = JSON.parse(runConfigured({ ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT }));
    const context: string = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain(rendered.bootstrapLine);
    expect(context).toContain(BOOTSTRAP_CALL.name);
    expect(context).toContain(`bootstrapped for ${TTL_HOURS} hours`);
  });

  it('injects the bootstrap policy the gate enforces, byte for byte', () => {
    const parsed = JSON.parse(runConfigured({ ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT }));
    expect(parsed.hookSpecificOutput.additionalContext).toContain(bootstrapPolicySentence());
  });

  it('a hook whose policy sentence was inverted fails that check (review 4ab06516 B1)', () => {
    // The review's second mutation, run through the same execution path.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-c9-policy-'));
    try {
      const script = path.join(scratch, 'inverted.sh');
      const original = read('.claude/hooks/relayhall-session-start.sh');
      // The hook holds the sentence inside a JSON string, so its quotes are
      // escaped there. JSON.stringify produces exactly that escaping, minus
      // the surrounding quotes - deriving it beats hand-counting backslashes.
      const escaped = JSON.stringify(bootstrapPolicySentence()).slice(1, -1);
      expect(original).toContain(escaped);
      fs.writeFileSync(
        script,
        original.replace(escaped, 'every work-plane call is open; nothing is refused.'),
      );
      const parsed = JSON.parse(execFileSync('bash', [script], { encoding: 'utf8' }));
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain(bootstrapPolicySentence());
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('runs identically when the harness sets no project directory', () => {
    const withVariable = runConfigured({ ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT });
    const without = { ...process.env };
    delete without.CLAUDE_PROJECT_DIR;
    expect(runConfigured(without)).toEqual(withVariable);
  });

  it('a hook whose text drifted fails the injection check', () => {
    // The control for the whole mechanism: same execution path, same
    // assertions, a script whose injected line no longer matches the product.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-c9-hook-'));
    try {
      const script = path.join(scratch, 'drifted.sh');
      fs.writeFileSync(
        script,
        read('.claude/hooks/relayhall-session-start.sh').replace(
          'fetch everything else from it',
          'use whatever you already have locally',
        ),
      );
      const parsed = JSON.parse(execFileSync('bash', [script], { encoding: 'utf8' }));
      const context: string = parsed.hookSpecificOutput.additionalContext;
      expect(context).not.toContain(rendered.bootstrapLine);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the published support matrix stays honest about what is released', () => {
  const matrix = read('docs/harness-support.md');

  /** Strategy §2.10, as ratified. The matrix quotes it; it may not soften it. */
  const RATIFIED_TIERS = [
    '**Tier A** full loop (Claude Code, Codex CLI, Gemini CLI: bootstrap, claim/lease, report, runner-wakeable);',
    '**Tier B** interactive board clients (ChatGPT developer mode, Antigravity: real MCP read/write behind OAuth, human-driven, no shell or scheduler);',
    '**Tier C** webhook automations (n8n and kin — ironically the most solid trigger mechanism in the whole design).',
  ].join(' ');

  /** The block quotation, unwrapped — so line breaks are not the contract. */
  const quotation = (text: string): string =>
    text.split('\n').filter((line) => line.startsWith('> ')).map((line) => line.slice(2))
      .join(' ').replace(/\s+/g, ' ').trim();

  it('quotes the ratified tier definitions verbatim', () => {
    expect(quotation(matrix)).toEqual(RATIFIED_TIERS);
  });

  it('a softened quotation fails that comparison', () => {
    const softened = matrix.replace('no shell or scheduler', 'limited shell');
    expect(softened).not.toEqual(matrix); // the mutation landed
    expect(quotation(softened)).not.toEqual(RATIFIED_TIERS);
  });

  // ── RH-P3.C6: the Tier-B row, flipped and BOUND ──────────────────────────
  //
  // C9 could only PIN the not-yet row: "nothing in this repository can
  // demonstrate the absence of an authorization server". Availability is the
  // opposite kind of claim — it can be observed — so it is bound three ways,
  // and the three are deliberately not the same kind of check:
  //
  //   1. the cell is RENDERED by production (`tierBAvailabilitySentence`) and
  //      compared byte for byte, so editing the page alone goes red;
  //   2. the renderer is compared to an ORACLE rebuilt below from the
  //      authorization server's own constants, with the relation written in
  //      this file, so editing the renderer alone goes red;
  //   3. a BEHAVIOURAL anchor calls the real refusal and the real challenge,
  //      so editing the constants AND the page together — which defeats (1)
  //      and (2), and is exactly the mutation verdict 41b196d3 B1 rejected an
  //      earlier suite for surviving — still goes red.

  it('publishes the Tier-B availability the product renders, byte for byte', () => {
    expect(matrix).toContain(tierBAvailabilitySentence());
  });

  it('the rendered availability matches an oracle built here, not from the renderer', () => {
    const expected = `**yes — the OAuth 2.1 authorization server is released: `
      + `${OAUTH_GRANT_TYPES_SUPPORTED.join(' + ')} grant, `
      + `${OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED.join('/')} PKCE required, `
      + `client identity by Client ID Metadata Document**`;
    expect(tierBAvailabilitySentence()).toEqual(expected);
  });

  /**
   * How the production token endpoint answers a grant, WITHOUT a database:
   * the grant gate is its first act, and everything after it fails on the
   * empty code long before a connection is opened. `unsupported_grant_type`
   * therefore means "refused AT the gate", and anything else means "got past
   * it" — which is exactly the distinction the anchor needs.
   */
  const grantGateAnswer = async (grantType: string): Promise<string> => {
    const outcome = await oauthAuthorizationService.exchangeCode({
      grantType, code: '', clientId: 'x', redirectUri: 'x', codeVerifier: 'x',
    }, { handle: 'system', authMethod: 'system' }).catch((error: unknown) => error);
    return outcome instanceof OAuthError ? outcome.oauthError : 'ACCEPTED';
  };

  it('every ADVERTISED grant is one the token endpoint really accepts', async () => {
    // Review 6fe97bc5 B1: the previous version of this anchor hard-coded both
    // the advertised value and the refused list, so changing the constant, the
    // page and the oracle together stayed green while the server went on
    // refusing the newly advertised grant. This loop is derived: whatever the
    // constant advertises must get PAST the production gate.
    const advertised = [...OAUTH_GRANT_TYPES_SUPPORTED];
    expect(advertised.length).toBeGreaterThan(0);
    for (const grant of advertised) {
      expect([grant, await grantGateAnswer(grant)])
        .not.toEqual([grant, 'unsupported_grant_type']);
    }
  });

  it('every grant it does NOT advertise is refused at that same gate', async () => {
    // The other direction, from the same constant. Together the two loops
    // cannot be satisfied by any edit to this file: a constant that names a
    // grant production refuses fails the first, and a grant production accepts
    // that the constant stops naming fails this one.
    const advertised = new Set<string>(OAUTH_GRANT_TYPES_SUPPORTED);
    const unadvertised = GRANTS_A_CLIENT_COULD_PRESENT.filter((grant) => !advertised.has(grant));
    // The control: both loops must actually have members, or one of them is
    // vacuous and proves nothing.
    expect(unadvertised.length).toBeGreaterThan(0);
    expect([...advertised].every((grant) => GRANTS_A_CLIENT_COULD_PRESENT.includes(grant))).toBe(true);
    for (const grant of unadvertised) {
      expect([grant, await grantGateAnswer(grant)]).toEqual([grant, 'unsupported_grant_type']);
    }
  });

  it('the method the server IMPLEMENTS is read off fixed RFC vectors, and is what it advertises', () => {
    // Review dc8691db B1. No transform lives here to be relabelled: the pair
    // below is RFC 7636 Appendix B, and `plain` is by definition the identity
    // challenge. Production is MEASURED, and the published constant must equal
    // the measurement — so advertising `plain` while the code hashes is red,
    // and no edit to this file can make it green without changing the server.
    const implemented: string[] = [];
    if (verifyPkceS256(RFC7636_VERIFIER, RFC7636_S256_CHALLENGE)) implemented.push('S256');
    if (verifyPkceS256(RFC7636_VERIFIER, RFC7636_VERIFIER)) implemented.push('plain');
    // A server that verifies neither vector advertises nothing truthfully.
    expect(implemented.length).toBeGreaterThan(0);
    expect([...OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED]).toEqual(implemented);
  });

  it('the PRODUCTION authorization gate accepts exactly the advertised method names', async () => {
    // The other half of the reviewer's prescription: anchor the name to the
    // gate that decides, by driving `beginAuthorization` itself.
    //
    // The CIMD fetch is stubbed — that is a DIFFERENT collaborator (an
    // outbound network call), not the thing under test, and stubbing it is
    // what lets the method gate be reached at all. Everything after the stub
    // is production: the exact redirect match, the response-type check and the
    // method gate, in their real order. The deliberately malformed challenge
    // means an ACCEPTED method still fails afterwards, on a different refusal
    // — and that difference is the measurement.
    const clientId = 'https://drift.example.com/client.json';
    const redirectUri = 'https://drift.example.com/cb';
    const resolve = jest.spyOn(oauthClientMetadataService, 'resolve').mockResolvedValue({
      clientId, clientName: 'drift', clientUri: null, logoUri: null,
      redirectUris: [redirectUri], scope: null, raw: {}, documentSha256: 'x'.repeat(64),
    });
    try {
      const gateAnswer = async (method: string): Promise<string> => {
        const outcome = await oauthAuthorizationService.beginAuthorization({
          clientId, redirectUri, responseType: 'code',
          codeChallenge: 'not-a-valid-challenge', codeChallengeMethod: method,
          scope: 'tasks:read', state: null, resource: null,
          boardEndpoint: 'https://board.example.com/api',
        }).catch((error: unknown) => error);
        return outcome instanceof OAuthError && outcome.message.includes('code_challenge_method')
          ? 'REFUSED_AT_METHOD_GATE' : 'PAST_METHOD_GATE';
      };
      const advertised = new Set<string>(OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED);
      const unadvertised = PKCE_METHODS_A_CLIENT_COULD_PRESENT.filter((m) => !advertised.has(m));
      // Both loops must have members, or one of them proves nothing.
      expect(advertised.size).toBeGreaterThan(0);
      expect(unadvertised.length).toBeGreaterThan(0);
      for (const method of advertised) {
        expect([method, await gateAnswer(method)]).toEqual([method, 'PAST_METHOD_GATE']);
      }
      for (const method of unadvertised) {
        expect([method, await gateAnswer(method)]).toEqual([method, 'REFUSED_AT_METHOD_GATE']);
      }
    } finally {
      resolve.mockRestore();
    }
  });

  it('the discovery advertisement the row depends on is really emitted', () => {
    // The other half of what C9 said would flip this row: "the MCP endpoint
    // deliberately advertises no OAuth protected-resource metadata today ...
    // when the authorization server ships, this row flips". This calls the
    // production challenge builder the MCP route calls.
    const challenge = mcpChallengeFor({
      headers: { host: 'board.example.com', 'x-forwarded-proto': 'https' },
      get: () => 'board.example.com',
    } as never);
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).toContain('/.well-known/oauth-protected-resource');
  });

  it('a page that reverted the row to C9 not-yet prose fails', () => {
    const reverted = matrix.replace(
      tierBAvailabilitySentence(),
      '**not yet — requires the OAuth 2.1 authorization server, not yet released**',
    );
    expect(reverted).not.toEqual(matrix); // the mutation landed
    expect(reverted).not.toContain(tierBAvailabilitySentence());
  });

  it('the page no longer carries any of the not-yet prose it shipped with', () => {
    // Flipping a table cell while leaving the paragraph underneath saying the
    // opposite is the drift this suite exists for.
    expect(matrix).not.toContain('not yet — requires the OAuth 2.1 authorization server');
    expect(matrix).not.toContain('deliberately advertises no OAuth');
    expect(matrix).not.toContain('Tier B is not available yet');
    expect(matrix).not.toContain('once the front door exists');
  });

  it('links the three packs it names', () => {
    for (const link of ['(../CLAUDE.md)', '(../AGENTS.md)', '(../GEMINI.md)']) {
      expect(matrix).toContain(link);
    }
  });
});
