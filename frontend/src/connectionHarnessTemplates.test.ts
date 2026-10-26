/*
 * THE HARNESS TEMPLATES (E462 slice S1; universal harness connector design
 * v1.5 sections 3.1 and 9).
 *
 * Four templates are harnesses: Claude Code, Codex, VS Code and Antigravity.
 * Each one makes ONE token (transport `any`, the harness scope set), declares
 * the telemetry tier and product its connector reports under, and shows one
 * install line. What is pinned here is the table and the helpers that read it,
 * so a change to what a harness token may do is a failing test rather than a
 * quiet edit to a constant:
 *
 *  - the harness scope set is written out in full below and compared to the
 *    code, and every member is read back out of the board's mintable
 *    catalogue on disk;
 *  - the set never carries `root`, an `:admin` scope or `services:write`;
 *  - the registration text of every template is unique, because the list maps
 *    a connector back to its template by exact match;
 *  - the install line is derived from the board's ORIGIN, never from the
 *    credential;
 *  - (E462 S2) a session that cannot delegate part of the harness set is told
 *    WHICH scopes, by name, and the authority sentence counts against the whole
 *    set, never against the cut-down ceiling.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_WORKING_SCOPES, CONNECTION_TEMPLATES, CREDENTIAL_TOKEN_PATTERN,
  HARNESS_CONNECTOR_SCOPES, connectorDescriptorFor, harnessAuthoritySentence, harnessDelegationWarning,
  harnessScopesMissing, installLineFor, installNoteFor, isHarnessTemplate, scopeCeilingFor, tabAppliesToTransport,
  templateForDescription,
} from './types/connections';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCOPE_MAP = readFileSync(join(HERE, '../../backend/src/utils/scopeMap.ts'), 'utf8');

const byKey = (key: string) => {
  const found = CONNECTION_TEMPLATES.find((template) => template.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};

/**
 * THE FULL SET, WRITTEN OUT (E462 §3.1 plus owner rulings E475 (1) and E480):
 * the Agent working set, the three the connector's other jobs need, the three
 * E475 adds — `knowledge-contents:read` (research), `personalities:read` and
 * `blueprints:use` — and the two E480 adds so a Blueprint can be instantiated,
 * `projects:write` and `phases:write`. Sixteen. Written here as literals, never
 * derived from the constant under test, so an edit to the constant alone fails.
 */
const RATIFIED_HARNESS_SET = [
  'tasks:read', 'tasks:write', 'reports:read', 'reports:write',
  'projects:read', 'phases:read', 'skills:read', 'skills:use',
  'telemetry:write', 'services:read', 'principals:read',
  'knowledge-contents:read', 'personalities:read', 'blueprints:use',
  'projects:write', 'phases:write',
];

describe('the harness scope set', () => {
  it('is exactly the ratified sixteen (E462 §3.1 + E475 (1) + E480), in that order — written out', () => {
    expect(HARNESS_CONNECTOR_SCOPES).toEqual(RATIFIED_HARNESS_SET);
    expect(RATIFIED_HARNESS_SET).toHaveLength(16);
    expect(HARNESS_CONNECTOR_SCOPES).toHaveLength(16);
    expect(new Set(HARNESS_CONNECTOR_SCOPES).size).toBe(HARNESS_CONNECTOR_SCOPES.length);
    // Built from the Agent working set, not restated: the two cannot drift.
    for (const scope of AGENT_WORKING_SCOPES) expect(HARNESS_CONNECTOR_SCOPES).toContain(scope);
  });

  it('never carries root, an :admin scope, services:write or any scope outside the set', () => {
    expect(HARNESS_CONNECTOR_SCOPES).not.toContain('root');
    expect(HARNESS_CONNECTOR_SCOPES).not.toContain('services:write');
    expect(HARNESS_CONNECTOR_SCOPES.filter((scope) => scope.endsWith(':admin'))).toEqual([]);
    expect(HARNESS_CONNECTOR_SCOPES.filter((scope) => !RATIFIED_HARNESS_SET.includes(scope))).toEqual([]);
    // E475: the three additions are the narrow verbs of their families. The
    // wider neighbours stay out — blueprints:use is NOT blueprints:read.
    for (const wider of ['blueprints:read', 'blueprints:write', 'personalities:use', 'personalities:write',
      'knowledge-contents:write', 'services:invoke', 'skills:write']) {
      expect(HARNESS_CONNECTOR_SCOPES).not.toContain(wider);
    }
    // E480: projects:write and phases:write are IN (instantiating a Blueprint
    // needs them); their :admin neighbours are not, nor is any other :admin.
    expect(HARNESS_CONNECTOR_SCOPES).toEqual(expect.arrayContaining(['projects:write', 'phases:write']));
    for (const admin of ['projects:admin', 'phases:admin', 'tasks:admin', 'blueprints:admin', 'services:admin']) {
      expect(HARNESS_CONNECTOR_SCOPES).not.toContain(admin);
    }
  });

  it('is the very set the live acceptance suite asserts a real harness token carries', () => {
    // The wizard constant and the backend's live assertion are two copies of one
    // fact, so a third thing compares them: change either side alone and this
    // fails, in the suite that can see both.
    const live = readFileSync(join(HERE, '../../backend/src/__tests__/dayOneConnectionAcceptance.test.ts'), 'utf8');
    const literal = /const HARNESS_SET = \[([\s\S]*?)\];/.exec(live);
    expect(literal).not.toBeNull();
    const asserted = Array.from(literal![1].matchAll(/'([a-z-]+:[a-z]+)'/g)).map((m) => m[1]);
    expect(asserted.length).toBeGreaterThan(8);
    expect([...asserted].sort()).toEqual([...HARNESS_CONNECTOR_SCOPES].sort());
  });

  it('every member is a scope the board can mint (read from the catalogue on disk)', () => {
    const mintable = /export const MINTABLE_SCOPES: Scope\[\] = \[([\s\S]*?)\];/.exec(SCOPE_MAP);
    expect(mintable).not.toBeNull();
    const catalogue = new Set(Array.from(mintable![1].matchAll(/'([a-z-]+:[a-z]+|root)'/g)).map((m) => m[1]));
    expect(catalogue.size).toBeGreaterThan(20);
    for (const scope of HARNESS_CONNECTOR_SCOPES) expect(catalogue.has(scope)).toBe(true);
    // CONTROL: the lookup can say no.
    expect(catalogue.has('tasks:teleport')).toBe(false);
  });
});

describe('the template table', () => {
  it('has the four harnesses first, in the design order, then the other choices', () => {
    expect(CONNECTION_TEMPLATES.map((template) => template.key)).toEqual([
      'claude-code', 'codex', 'vscode', 'antigravity', 'generic-mcp', 'api-script', 'messaging-gateway',
    ]);
    expect(CONNECTION_TEMPLATES.map((template) => template.label)).toEqual([
      'Claude Code', 'Codex', 'VS Code', 'Antigravity', 'Generic MCP client', 'API script', 'Messaging gateway',
    ]);
  });

  it('declares each harness token as ONE any-pinned credential with the harness set', () => {
    for (const key of ['claude-code', 'codex', 'vscode', 'antigravity']) {
      const template = byKey(key);
      expect(isHarnessTemplate(template)).toBe(true);
      expect(template.transport).toBe('any');
      expect(template.suggestedScopes).toEqual(HARNESS_CONNECTOR_SCOPES);
    }
  });

  it('declares the telemetry tier and product each connector reports under', () => {
    const declared = Object.fromEntries(['claude-code', 'codex', 'vscode', 'antigravity']
      .map((key) => [key, byKey(key).harness]));
    expect(declared).toEqual({
      'claude-code': { key: 'claude-code', telemetryTier: 'full', telemetryProduct: 'claude-code' },
      codex: { key: 'codex', telemetryTier: 'full', telemetryProduct: 'openai-codex' },
      vscode: { key: 'vscode', telemetryTier: 'presence', telemetryProduct: 'vscode' },
      antigravity: { key: 'antigravity', telemetryTier: 'presence', telemetryProduct: 'antigravity' },
    });
    // The board's product grammar (backend/src/utils/serviceDescriptor.ts).
    for (const harness of Object.values(declared)) {
      expect(harness!.telemetryProduct).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
  });

  it('leaves the other templates exactly as they were', () => {
    for (const key of ['generic-mcp', 'api-script', 'messaging-gateway']) {
      expect(isHarnessTemplate(byKey(key))).toBe(false);
      expect(connectorDescriptorFor(byKey(key))).toBeNull();
      expect(installLineFor(byKey(key), 'https://board.example/api')).toBeNull();
    }
    expect(byKey('generic-mcp').transport).toBe('mcp');
    expect(byKey('api-script').transport).toBe('api');
    expect(byKey('generic-mcp').suggestedScopes).toEqual(AGENT_WORKING_SCOPES);
  });

  it('keeps every registration text unique, and the list maps Antigravity back', () => {
    const texts = CONNECTION_TEMPLATES.map((template) => template.registrationText);
    expect(new Set(texts).size).toBe(texts.length);
    expect(templateForDescription('Antigravity, connected from the Connect your agent flow.')?.key)
      .toBe('antigravity');
    // The three that already existed keep the text connections already hold.
    expect(byKey('claude-code').registrationText).toBe('Claude Code, connected from the Connect your agent flow.');
    expect(byKey('codex').registrationText).toBe('Codex, connected from the Connect your agent flow.');
    expect(byKey('vscode').registrationText).toBe('VS Code, connected from the Connect your agent flow.');
  });

  it('opens every tab for an any-pinned harness token, because the token works on REST and MCP', () => {
    for (const tab of ['claudeCode', 'codex', 'generic', 'cli'] as const) {
      expect(tabAppliesToTransport(tab, 'any')).toBe(true);
    }
  });
});

describe('the ceiling a template puts on the token', () => {
  const root = [...HARNESS_CONNECTOR_SCOPES, 'tasks:admin', 'services:write', 'services:admin', 'blueprints:read'];

  it('a harness template cuts the delegable set down to the harness set', () => {
    expect(scopeCeilingFor(byKey('claude-code'), root).sort()).toEqual([...HARNESS_CONNECTOR_SCOPES].sort());
  });

  it('it can only narrow: a session that lacks a harness scope simply does not get it', () => {
    expect(scopeCeilingFor(byKey('codex'), ['tasks:read', 'telemetry:write', 'blueprints:read']))
      .toEqual(['tasks:read', 'telemetry:write']);
    expect(scopeCeilingFor(byKey('codex'), [])).toEqual([]);
  });

  it('a non-harness template, or none yet, leaves the whole delegable set (decision 1)', () => {
    expect(scopeCeilingFor(byKey('generic-mcp'), root)).toEqual(root);
    expect(scopeCeilingFor(byKey('api-script'), root)).toEqual(root);
    expect(scopeCeilingFor(null, root)).toEqual(root);
  });

  it('says what the harness token is, in a sentence that is true', () => {
    const sentence = harnessAuthoritySentence(16);
    expect(HARNESS_CONNECTOR_SCOPES).toHaveLength(16);
    expect(sentence).toContain('16 of the 16');
    expect(sentence).toMatch(/never given administrator rights/i);
    expect(sentence).toMatch(/change services/i);
  });

  it('counts against the WHOLE harness set, so a cut-down token never reads as complete (E462 S2)', () => {
    // A session that may delegate five of the sixteen: the ceiling is five, and
    // the sentence must not say "5 of the 5".
    const five = ['tasks:read', 'tasks:write', 'reports:read', 'telemetry:write', 'principals:read'];
    const ceiling = scopeCeilingFor(byKey('codex'), five);
    expect(harnessAuthoritySentence(ceiling.length)).toContain('5 of the 16');
    expect(harnessAuthoritySentence(ceiling.length)).not.toContain('5 of the 5');
  });

  it('names what the session cannot pass on, in the harness set order (E462 S2)', () => {
    expect(harnessScopesMissing([...HARNESS_CONNECTOR_SCOPES, 'tasks:admin'])).toEqual([]);
    expect(harnessScopesMissing(['tasks:read', 'tasks:write', 'reports:read', 'telemetry:write', 'principals:read']))
      .toEqual(['reports:write', 'projects:read', 'phases:read', 'skills:read', 'skills:use', 'services:read',
        'knowledge-contents:read', 'personalities:read', 'blueprints:use', 'projects:write', 'phases:write']);
    expect(harnessScopesMissing([])).toEqual(HARNESS_CONNECTOR_SCOPES);
  });

  it('warns by name, singular and plural, and says nothing when nothing is missing (E462 S2)', () => {
    expect(harnessDelegationWarning([])).toBeNull();
    const one = harnessDelegationWarning(['telemetry:write'])!;
    expect(one).toContain('You cannot pass on telemetry:write, so this token will not have it.');
    expect(one).toContain('relayhall connector check will fail');
    const many = harnessDelegationWarning(['telemetry:write', 'services:read', 'principals:read'])!;
    expect(many).toContain('You cannot pass on telemetry:write, services:read and principals:read, so this token will not have them.');
    expect(many).toContain('Credentials page');
  });
});

describe('what the installer says per harness (E462 S2; E475 (2))', () => {
  it('only Antigravity carries a note: the installer writes its MCP config, with a backup, and no token', () => {
    const note = installNoteFor(byKey('antigravity'))!;
    expect(note).toContain('~/.gemini/config/mcp_config.json');
    expect(note).toMatch(/backup/);
    expect(note).toMatch(/holds no token/);
    // The S2 sentence is gone: it is no longer true.
    expect(note).not.toMatch(/does not edit Antigravity's configuration/);
    for (const key of ['claude-code', 'codex', 'vscode', 'generic-mcp', 'api-script']) {
      expect(installNoteFor(byKey(key))).toBeNull();
    }
    expect(installNoteFor(null)).toBeNull();
  });
});

describe('the descriptor the wizard registers', () => {
  it('is an options-free telemetry declaration naming exactly one product', () => {
    expect(connectorDescriptorFor(byKey('claude-code'))).toEqual({
      options: [], telemetry: { tier: 'full', products: ['claude-code'] },
    });
    expect(connectorDescriptorFor(byKey('antigravity'))).toEqual({
      options: [], telemetry: { tier: 'presence', products: ['antigravity'] },
    });
  });
});

describe('the install line', () => {
  it('names the harness and the board ORIGIN, with no credential on it', () => {
    expect(installLineFor(byKey('claude-code'), 'https://board.example/api'))
      .toBe('relayhall connector install --harness claude-code --board https://board.example');
    expect(installLineFor(byKey('vscode'), 'http://localhost:8082/api'))
      .toBe('relayhall connector install --harness vscode --board http://localhost:8082');
    for (const template of CONNECTION_TEMPLATES) {
      const line = installLineFor(template, 'https://board.example/api') ?? '';
      expect(CREDENTIAL_TOKEN_PATTERN.test(line)).toBe(false);
      expect(line).not.toMatch(/token|bearer|rh_/i);
    }
  });

  it('refuses to guess from an endpoint that is not a URL', () => {
    expect(installLineFor(byKey('codex'), 'not a url')).toBeNull();
    expect(installLineFor(byKey('codex'), '')).toBeNull();
  });
});
