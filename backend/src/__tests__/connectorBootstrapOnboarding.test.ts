/**
 * Card 94e8bb0b items 1 and 2: the one copyable bootstrap prompt, the secure
 * configuration guidance beside it, and the reviewed source of the registry
 * Skill the prompt sends a fresh session to.
 *
 * What is pinned, and how:
 *
 *  1. NO CREDENTIAL IN THE PROMPT, BY CONSTRUCTION. The composers take the MCP
 *     endpoint and nothing else, and the pack renders the same prompt whatever
 *     secret it carries. A control proves the same pack DOES carry the secret
 *     elsewhere and that the token pattern fires on it, so "absent" is a
 *     measurement, not a pattern that could never match.
 *  2. THE TOOLS THE TEXT NAMES ARE THE TOOLS THE BOARD SERVES. Every
 *     `relayhall_*` identifier in the prompt, the guidance and the Skill source
 *     is resolved through the production registry (`toolByName`), with a
 *     control showing an unregistered name is refused.
 *  3. THE SKILL SOURCE IS A DOCUMENT THE REGISTRY WILL ACCEPT under the name
 *     the prompt uses: it goes through the production SKILL.md parser with the
 *     catalog name as the expected name.
 *  4. THE INSTALLER THE SKILL TELLS A SESSION TO RUN EXISTS: the subcommand
 *     and both harness names are read out of the CLI module that registers them.
 */
import fs from 'fs';
import path from 'path';

import { toolByName } from '../mcp/registry';
import { MAX_SKILL_MD_BYTES, parseSkillDocument } from '../utils/skillDocument';
import {
  CONNECTOR_BOOTSTRAP_SKILL, CONNECTOR_READ_BOUNDARY, MCP_SERVER_ALIAS, TOKEN_ENV_VAR,
  composeBootstrapPrompt, composeConfigurationGuidance, composeOnboardingPack,
} from '../utils/onboardingPack';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skills', CONNECTOR_BOOTSTRAP_SKILL, 'SKILL.md');
const INSTALLER = path.join(REPO_ROOT, 'cli', 'relayhall_connection_skill.py');
const ENDPOINT = 'https://board.example/api';
const MCP_ENDPOINT = `${ENDPOINT}/mcp`;
const SECRET = 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000';
/** The minted grammar with the environment segment open (rh_live_, rh_dev_, ...). */
const TOKEN = /rh_[a-z]+_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}/;

const packWith = (secretOnce: string) => composeOnboardingPack({
  endpoint: ENDPOINT,
  credential: { credentialId: 'c1', keyId: 'k1', secretOnce, expiresAt: null, transport: 'mcp' },
  scopes: ['tasks:read'],
  rules: [],
});

const namedTools = (text: string): string[] =>
  Array.from(new Set(text.match(/\brelayhall_[a-z_]+\b/g) ?? []));

describe('the bootstrap prompt (card 94e8bb0b item 1)', () => {
  const pack = packWith(SECRET);

  it('names the configured MCP origin, the session brief, the published Skill, the onboarding and the measured result', () => {
    const prompt = pack.bootstrapPrompt;
    expect(prompt).toContain(`"${MCP_SERVER_ALIAS}" at ${MCP_ENDPOINT}`);
    expect(prompt).toContain('relayhall_brief_compile with {"session": true}');
    expect(prompt).toContain(`published Skill ${CONNECTOR_BOOTSTRAP_SKILL}`);
    expect(prompt).toContain('relayhall_skill_list');
    expect(prompt).toContain('relayhall_skill_get (fullContent: true)');
    expect(prompt).toContain('run the onboarding it describes');
    expect(prompt).toContain('readiness matrix: measured results with real ids, then the remaining gaps');
    expect(prompt).toContain('Do not arm or claim unrelated work.');
    expect(prompt).toContain('never paste the credential');
  });

  it('is short: five lines, well under one screen', () => {
    expect(pack.bootstrapPrompt.split('\n')).toHaveLength(5);
    expect(pack.bootstrapPrompt.length).toBeLessThan(900);
  });

  // Owner ruling E475 (3): a new connector reads the board through MCP and its
  // own folders only. The boundary is its own line, second, before any read the
  // prompt asks for, and it is the SAME sentence the registry Skill carries.
  it('bounds what a new connector may read: the board through MCP and its own folders, nothing else (E475 (3))', () => {
    const lines = pack.bootstrapPrompt.split('\n');
    expect(lines[1]).toBe(CONNECTOR_READ_BOUNDARY);
    expect(CONNECTOR_READ_BOUNDARY).toBe(
      "Read only the board, through this MCP server, and this connector's own folders (its MCP entry, its local connection skill and its state folder); never the owner's private working set, other sessions' scratchpads or other hosts.",
    );
  });

  it('CONTROL: a prompt without the boundary line fails the same comparison', () => {
    const lines = pack.bootstrapPrompt.split('\n').filter((line) => line !== CONNECTOR_READ_BOUNDARY);
    expect(lines).toHaveLength(4);
    expect(lines[1]).not.toBe(CONNECTOR_READ_BOUNDARY);
  });

  it('never carries the credential: identical whatever secret the pack holds', () => {
    const other = packWith('${RELAYHALL_TOKEN}');
    expect(other.bootstrapPrompt).toBe(pack.bootstrapPrompt);
    expect(other.configurationGuidance).toEqual(pack.configurationGuidance);
    for (const text of [pack.bootstrapPrompt, ...pack.configurationGuidance]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(TOKEN);
      expect(text).not.toMatch(/\bBearer\b/);
    }
    // The composers cannot be handed a credential: their only input is the endpoint.
    expect(composeBootstrapPrompt.length).toBe(1);
    expect(composeConfigurationGuidance.length).toBe(1);
    expect(pack.bootstrapPrompt).toBe(composeBootstrapPrompt(MCP_ENDPOINT));
    expect(pack.configurationGuidance).toEqual(composeConfigurationGuidance(MCP_ENDPOINT));
  });

  it('CONTROL: the same pack does carry the secret elsewhere, and the pattern fires on it', () => {
    expect(JSON.stringify(pack.mcpConfig)).toContain(SECRET);
    expect(pack.cliEnv.join('\n')).toContain(SECRET);
    expect(TOKEN.test(SECRET)).toBe(true);
    expect(TOKEN.test('rh_live_k3y1d0.0123456789abcdefghijKLMN')).toBe(true);
  });

  it('gives secure configuration guidance: the server entry, where the credential lives and the local installer', () => {
    const guidance = pack.configurationGuidance.join('\n');
    expect(guidance).toContain(`"${MCP_SERVER_ALIAS}" at ${MCP_ENDPOINT}`);
    expect(guidance).toContain(`the ${TOKEN_ENV_VAR} environment variable`);
    expect(guidance).toContain('Never put it in a prompt, a Skill, a Report or a repository');
    expect(guidance).toContain('${RELAYHALL_TOKEN}');
    expect(guidance).toContain('relayhall connection-skill install --harness claude-code (or --harness codex)');
    expect(pack.configurationGuidance.length).toBeLessThanOrEqual(4);
  });

  it('every tool the prompt and the guidance name is one the board registers', () => {
    const names = namedTools([pack.bootstrapPrompt, ...pack.configurationGuidance].join('\n'));
    expect(names.sort()).toEqual(['relayhall_brief_compile', 'relayhall_skill_get', 'relayhall_skill_list']);
    expect(names.filter((name) => !toolByName(name))).toEqual([]);
  });

  it('CONTROL: an unregistered tool name is refused by the same lookup', () => {
    expect(toolByName('relayhall_task_teleport')).toBeUndefined();
  });

  it('the copy docs/connector-onboarding.md publishes is the renderer\'s own text for the placeholder board', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'connector-onboarding.md'), 'utf8');
    const rendered = composeBootstrapPrompt('https://<your-board>/api/mcp');
    expect(doc).toContain('```text\n' + rendered + '\n```');
    // CONTROL: a one-word drift in the published copy is caught by the same comparison.
    expect(doc).not.toContain('```text\n' + rendered.replace('readiness matrix', 'status table') + '\n```');
  });
});

describe('the registry Skill source (card 94e8bb0b item 2)', () => {
  const source = fs.readFileSync(SKILL_SOURCE, 'utf8');
  const body = source.slice(source.indexOf('\n---\n', 4) + 5);

  it('is a SKILL.md the production parser accepts under the catalog name the prompt uses', () => {
    expect(parseSkillDocument(source, CONNECTOR_BOOTSTRAP_SKILL).name).toBe(CONNECTOR_BOOTSTRAP_SKILL);
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(MAX_SKILL_MD_BYTES);
    // LF only: the registry digests the exact bytes it stores.
    expect(source).not.toContain('\r');
  });

  it('CONTROL: the same parser refuses the document under any other catalog name', () => {
    expect(() => parseSkillDocument(source, 'relayhall-connection')).toThrow(/must match catalog name/);
  });

  it('discovers identity, transport, scopes, expiry and object permissions through tools the board registers', () => {
    const names = namedTools(source);
    for (const required of [
      'relayhall_brief_compile', 'relayhall_principal_whoami', 'relayhall_access_preview',
      'relayhall_skill_list', 'relayhall_skill_get', 'relayhall_service_list', 'relayhall_charter_get',
    ]) {
      expect(names).toContain(required);
    }
    expect(names.filter((name) => !toolByName(name))).toEqual([]);
    for (const fact of ['transport', 'expiry', 'scopes', 'object-authority', 'input schemas']) {
      expect(body).toContain(fact);
    }
  });

  it('distinguishes listed, granted, configured and tested capability as four rows of one table', () => {
    for (const level of ['listed', 'granted', 'configured', 'tested']) {
      expect(body).toMatch(new RegExp(`^\\| ${level} \\|`, 'm'));
    }
    expect(body).toContain('Listed is not granted, granted is not configured, configured is not tested.');
  });

  it('loads role guidance progressively and ends with a compact readiness matrix with real ids', () => {
    expect(body).toContain('Load full text only when the next step needs it');
    expect(body).toContain('ifNoneMatch');
    for (const role of ['implementer', 'Verifier', 'orchestrator']) expect(body).toContain(`- ${role}:`);
    expect(body).toContain('| Capability | Level | Evidence (real ids) | Limit or gap | Next action |');
    expect(body.trimEnd().endsWith('genuinely missing.')).toBe(true);
  });

  it('bounds what a new connector may read with the prompt\'s own sentence, as a ground rule (E475 (3))', () => {
    const rules = body.slice(body.indexOf('## Ground rules'), body.indexOf('## 1.'));
    expect(rules).toContain(`- ${CONNECTOR_READ_BOUNDARY}`);
    // It also says what to do when an answer lies outside the boundary.
    expect(rules).toContain('a gap to report, not a reason to look further');
    // CONTROL: the comparison is against the ground rules, not anywhere in the file.
    expect(rules.replace(CONNECTOR_READ_BOUNDARY, '')).not.toContain(CONNECTOR_READ_BOUNDARY);
  });

  it('names its own folders in the sentence itself, so no other folder can pass for one (E475 (3))', () => {
    expect(CONNECTOR_READ_BOUNDARY).toContain(
      "this connector's own folders (its MCP entry, its local connection skill and its state folder);",
    );
    expect(body).toContain('The folder the harness was opened in is not one of them');
  });

  it('sends a new connector to no checkout: a present local pointer means nothing to do, a missing one is a gap', () => {
    const pointer = body.slice(body.indexOf('## 4. Local connection pointer'), body.indexOf('## 5.'));
    expect(pointer).toContain('If it is already present');
    expect(pointer).toContain('do nothing');
    expect(pointer).toContain('ask the\nperson to run');
    expect(pointer).toContain('report the missing pointer as a gap');
    expect(pointer).not.toMatch(/RelayHall checkout|cli\/relayhall/);
    // CONTROL: the section was found, so the negative match is over real text.
    expect(pointer).toContain('relayhall connection-skill install --harness claude-code');
  });

  it('never arms unrelated work and never handles the credential', () => {
    expect(body).toContain('Never arm, claim, move or finish existing Tasks while onboarding.');
    expect(body).toContain('Never');
    expect(source).not.toMatch(TOKEN);
    expect(source).not.toMatch(/\bBearer\b/);
  });

  it('points at the installer the CLI actually registers, for the three harnesses it supports', () => {
    const installer = fs.readFileSync(INSTALLER, 'utf8');
    expect(body).toContain('relayhall connection-skill install --harness claude-code');
    expect(body).toContain('--harness codex');
    expect(body).toContain('--harness antigravity');
    expect(installer).toContain('"connection-skill"');
    expect(installer).toMatch(/"claude-code": \("Claude Code"/);
    expect(installer).toMatch(/"codex": \("Codex"/);
    expect(installer).toMatch(/"antigravity": \("Antigravity"/);
    expect(installer).toContain(`REGISTRY_SKILL = "${CONNECTOR_BOOTSTRAP_SKILL}"`);
    expect(body).toContain('`relayhall-connection/SKILL.md`');
    expect(installer).toContain('LOCAL_SKILL = "relayhall-connection"');
  });
});
