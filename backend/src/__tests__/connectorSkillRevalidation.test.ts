/**
 * Card 94e8bb0b items 2 and 3, round-1 blocker B1: the value a session is
 * told to send as `ifNoneMatch` must be one the board answers "not modified"
 * to.
 *
 * The content route sets `ETag: "<content_sha256>"` (quoted) and compares
 * If-None-Match by exact string after stripping `W/` (routes/skills.ts), and
 * relayhall_skill_get forwards ifNoneMatch unchanged. A bare digest is
 * therefore always a full refetch, and the local pointer's own rule ("new
 * content means a newer Version is published") would then report a newer
 * Version on every refresh.
 *
 * What is pinned, end to end through the real MCP tool handler, the real
 * in-process dispatcher and the real content route (only identity, the row
 * grant and the Skill rows are stubbed, as in c4SkillsCacheDoctrine):
 *
 *  1. THE INSTALLER'S VALUE. The block cli/relayhall_connection_skill.py
 *     renders is read from a golden fixture that cli/test_connection_skill.py
 *     proves the renderer still produces byte for byte; its ifNoneMatch value
 *     gets "not modified".
 *  2. THE REGISTRY SKILL'S VALUE. The literal the Skill source spells out,
 *     filled in with the digest, gets "not modified".
 *  3. CONTROLS. The bare digest and a different digest each get the full
 *     content, so the "not modified" above is a measurement and not a handler
 *     that always says it.
 */
import fs from 'fs';
import path from 'path';

import { toolByName } from '../mcp/registry';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { skillManager } from '../services/SkillManager';
import { CONNECTOR_BOOTSTRAP_SKILL } from '../utils/onboardingPack';

interface Golden {
  inputs: { skill: { id: string; version: number; sha256: string } };
  block: string;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'connection-skill-block.json');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skills', CONNECTOR_BOOTSTRAP_SKILL, 'SKILL.md');
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
const { id: SKILL_ID, version: VERSION_NUMBER, sha256: SHA } = golden.inputs.skill;
const VERSION_ID = '9d3c1b2a-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const BEARER = 'Bearer rh_dev_keyid01.secretsecretsecretsecret';
const BODY = '# relayhall-connector-bootstrap\nbody';
/** Step 2 of the managed block: "`ifNoneMatch` set to `<value>`". */
const RENDERED_VALUE = /`ifNoneMatch` set to `([^`]+)`/g;

function authenticateWith(scopes: string[]): void {
  const principal: Principal = {
    id: '66666666-6666-4666-8666-666666666666', kind: 'service', handle: 'connector_one',
    displayName: null, status: 'active', role: 'agent', boundTaskId: null, purpose: null,
    legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
    personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
  };
  const credential: PrincipalCredential = {
    id: '77777777-7777-4777-8777-777777777777', principalId: principal.id, credentialType: 'api_key',
    keyId: 'keyid01', scopes, expiresAt: null, revokedAt: null, transport: 'mcp',
    graceUntil: null, metadata: {},
  };
  jest.spyOn(principalService, 'authenticatePrincipalKey').mockResolvedValue({ principal, credential });
}

/** Exactly what the pointer's step 2 says: the id, fullContent and ifNoneMatch, no version. */
async function revalidate(ifNoneMatch: string): Promise<string> {
  const tool = toolByName('relayhall_skill_get');
  if (!tool) throw new Error('relayhall_skill_get is not registered');
  return tool.handler(
    { skillId: SKILL_ID, fullContent: true, ifNoneMatch },
    { authorization: BEARER, toolName: 'relayhall_skill_get' },
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
  jest.spyOn(authorizationRepository, 'authorizePoint').mockResolvedValue({ exists: true, allowed: true } as never);
  authenticateWith(['skills:read', 'skills:use']);
  jest.spyOn(skillManager, 'getById').mockResolvedValue({
    id: SKILL_ID, name: CONNECTOR_BOOTSTRAP_SKILL, category: 'workflow',
    current_published_version_id: VERSION_ID,
    published_version: { id: VERSION_ID, version: VERSION_NUMBER, content_sha256: SHA },
  } as never);
  jest.spyOn(skillManager, 'getVersion').mockResolvedValue({
    id: VERSION_ID, skill_id: SKILL_ID, version: VERSION_NUMBER, skill_md: BODY,
    content_sha256: SHA, status: 'published',
  } as never);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('the local pointer written by relayhall connection-skill install (item 3)', () => {
  it('renders exactly one ifNoneMatch value, and it is the quoted etag form of the recorded digest', () => {
    const values = Array.from(golden.block.matchAll(RENDERED_VALUE), (match) => match[1]);
    expect(values).toEqual([`"${SHA}"`]);
    expect(golden.block).toContain(`sha256 \`${SHA}\``);
  });

  it('that value gets "not modified" from relayhall_skill_get, through the real content route', async () => {
    const [value] = Array.from(golden.block.matchAll(RENDERED_VALUE), (match) => match[1]);
    const text = await revalidate(value);
    expect(text).toMatch(/^not modified/);
    expect(text).toContain(`etag "${SHA}"`);
    expect(text).not.toContain(BODY);
    // The handler resolved the publication pointer and asked the content route
    // for that Version, with content: the 304 came from the real comparison.
    expect(skillManager.getById).toHaveBeenCalledWith(SKILL_ID, expect.anything());
    expect(skillManager.getVersion).toHaveBeenCalledWith(SKILL_ID, VERSION_ID, true, expect.anything());
  });

  it('CONTROL: the bare digest the pointer used to name gets the full content, never "not modified"', async () => {
    const text = await revalidate(SHA);
    expect(text).not.toMatch(/not modified/);
    expect(text).toContain(`etag: "${SHA}"`);
    expect(text).toContain(BODY);
  });

  it('CONTROL: a different digest in the etag form gets the full content too', async () => {
    const text = await revalidate(`"${'0'.repeat(64)}"`);
    expect(text).not.toMatch(/not modified/);
    expect(text).toContain(BODY);
  });
});

describe('the registry Skill source (item 2)', () => {
  const source = fs.readFileSync(SKILL_SOURCE, 'utf8');
  const prose = source.replace(/\s+/g, ' ');

  it('tells a session to send the etag back, quotes included, and no longer the bare digest', () => {
    expect(prose).toContain('That read returns an etag: the digest in double quotes, `"<sha256>"`.');
    expect(prose).toContain('pass that etag back as `ifNoneMatch`, quotes included');
    expect(prose).not.toContain('pass its digest as `ifNoneMatch`');
  });

  it('the literal it spells out, filled in with the digest, gets "not modified"', async () => {
    // Any backticked literal holding the <sha256> placeholder, quoted or not:
    // the route's answer decides, and only then is the spelling compared.
    const literals = Array.from(source.matchAll(/`([^`\n]*<sha256>[^`\n]*)`/g), (match) => match[1]);
    expect(literals).toHaveLength(1);
    const text = await revalidate(literals[0].replace('<sha256>', SHA));
    expect(text).toMatch(/^not modified/);
    expect(literals).toEqual(['"<sha256>"']);
  });
});
